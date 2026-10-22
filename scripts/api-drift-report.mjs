/**
 * Builds the nightly API drift report that .github/workflows/api-contract.yml
 * posts to #main-build-alerts.
 *
 * Two reports, because they answer different questions:
 *
 * - The reference changelog: what changed in the staging API since the
 *   snapshots in api-reference/ were taken, from oasdiff. Operations and fields
 *   added, removed or changed, with oasdiff's breaking verdict on each.
 * - The SDK drift: the operations marked for the SDK that it never calls, and
 *   the routes it calls that staging does not have, from
 *   scripts/check-api-contract.mjs, run as it is.
 *
 * Either one being non-empty makes the run red: SDK drift needs fixing, and a
 * changelog means the snapshots are behind even when the SDK happens to match.
 *
 * The report is written to --out as files the notify step reads:
 *
 *   state        red | green
 *   body.txt     the Slack message below its headline: summary, run link, and
 *                both reports trimmed to fit
 *   summary.md   both reports in full, for the job summary
 *
 * Exits 0 when the report was built (red or green) and 2 when it could not be,
 * for example when the staging reference did not answer: an outage is not
 * drift, and must not post or change the notify state.
 *
 * A reference URL that answers 404 is not published yet (it goes live with
 * introspection-cloud#3489): the run then says so, writes no `state`, and
 * exits 0, so the workflow neither posts nor records a state. Any other error
 * reading a reference (5xx, timeout, invalid JSON) still exits 2.
 *
 * Run: node scripts/api-drift-report.mjs --out DIR [--run-url URL]
 * env: OASDIFF  the oasdiff binary (default: oasdiff on PATH)
 *      API_CONTRACT_DATAPLANE, API_CONTRACT_CONTROLPLANE  a URL or file to
 *        read instead of staging, for both reports (the check reads them too)
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { referenceSource } from "./api-contract/reference.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLANES = ["dataplane", "controlplane"];

const SNAPSHOT = (plane) => resolve(ROOT, `api-reference/${plane}.json`);

/**
 * Characters the SDK drift, and each plane's changelog, may take in the Slack
 * message. Slack truncates a message at 40,000 characters, but one much past
 * 10,000 is unreadable in the channel; the job summary carries the rest.
 */
const DRIFT_BUDGET = 3500;
const PLANE_BUDGET = 2500;

/** oasdiff's levels: error is breaking, warning is potentially breaking. */
const LEVELS = { 3: "BREAKING", 2: "MAYBE BREAKING", 1: "" };

function arg(name, fallback) {
  const flag = process.argv.indexOf(name);
  return flag === -1 ? fallback : process.argv[flag + 1];
}

/** Changes from the snapshot to the staging reference, as oasdiff's JSON. */
function changelog(plane) {
  const result = spawnSync(
    process.env.OASDIFF || "oasdiff",
    ["changelog", SNAPSHOT(plane), referenceSource(plane), "--format", "json"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(
      `oasdiff could not compare the ${plane} snapshot with ${referenceSource(plane)}: ${
        result.error?.message ?? result.stderr.trim()
      }`,
    );
  }
  return JSON.parse(result.stdout || "[]");
}

/**
 * The planes whose reference URL answers 404, after reading every URL
 * reference once so any other failure (5xx, timeout, invalid JSON) throws.
 */
async function unpublished() {
  const missing = [];
  for (const plane of PLANES) {
    const source = referenceSource(plane);
    if (!/^https?:\/\//.test(source)) continue;
    const response = await fetch(source, {
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) missing.push(plane);
    else if (!response.ok)
      throw new Error(`${source} answered HTTP ${response.status}`);
    else await response.json();
  }
  return missing;
}

/** Where a change applies: an operation, or the spec section it sits in. */
const where = (change) =>
  change.path ? `${change.operation} ${change.path}` : change.section;

/**
 * Groups `items` by `keyOf`, keeping the first item of each group and the
 * sorted, distinct values of `valueOf` across the group.
 */
function groupBy(items, keyOf, valueOf) {
  const groups = new Map();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key) ?? { ...item, values: new Set() };
    group.values.add(valueOf(item));
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    ...group,
    values: [...group.values].sort(),
  }));
}

/**
 * One plane's changes, most important first: the operations added and
 * removed, then one line per distinct change with every operation it applies
 * to. Grouping matters: a parameter added to forty endpoints is one fact, not
 * forty lines, and so are fourteen values removed from one enum.
 */
function renderPlane(plane, changes) {
  const operations = (id) =>
    changes
      .filter((c) => c.id === id)
      .map(where)
      .sort();
  const added = operations("endpoint-added");
  const removed = operations("endpoint-removed");

  const rest = changes.filter(
    (c) => c.id !== "endpoint-added" && c.id !== "endpoint-removed",
  );
  // The same change on several operations, then the same change to several
  // values (the first `quoted` name in its text) on the same operations.
  const byText = groupBy(rest, (c) => `${c.level}\u0000${c.text}`, where);
  const template = (c) => c.text.replace(/`[^`]*`/, "`…`");
  const lines = groupBy(
    byText,
    (g) => `${g.level}\u0000${template(g)}\u0000${g.values.join()}`,
    (g) => g.text.match(/`([^`]*)`/)?.[1] ?? "",
  )
    .map((group) => {
      const text =
        group.values.length > 1
          ? template(group).replace("…", () => group.values.join("`, `"))
          : group.text;
      return {
        ...group,
        text,
        where: byText.find((g) => g.text === group.text).values,
      };
    })
    .sort(
      (a, b) =>
        b.level - a.level ||
        b.where.length - a.where.length ||
        a.text.localeCompare(b.text),
    )
    .map((group) => {
      const level = LEVELS[group.level] ? `${LEVELS[group.level]}: ` : "";
      return `  ${level}${group.text} — ${group.where.join(", ")}`;
    });

  const count = (level) => changes.filter((c) => c.level === level).length;
  const header =
    `${plane}: ${changes.length} changes — ` +
    [
      `${count(3)} breaking`,
      `${count(2)} potentially breaking`,
      `${added.length} operations added`,
      `${removed.length} removed`,
    ].join(", ");
  const text = [
    header,
    ...(added.length ? [`  operations added: ${added.join(", ")}`] : []),
    ...(removed.length
      ? [`  BREAKING: operations removed: ${removed.join(", ")}`]
      : []),
    ...lines,
  ].join("\n");
  return { header, text, changed: changes.length > 0 };
}

/**
 * The SDK drift as check-api-contract.mjs reports it, and its one-line
 * summary of counts. A run
 * that ends without that summary crashed: an error, not drift.
 */
function sdkDrift() {
  const result = spawnSync(
    process.execPath,
    // The same documents oasdiff reads, whatever `--<plane>` or env chose.
    [
      resolve(ROOT, "scripts/check-api-contract.mjs"),
      ...PLANES.flatMap((plane) => [`--${plane}`, referenceSource(plane)]),
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  const output = `${result.stderr}\n${result.stdout}`
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .join("\n\n");
  const summary = /^summary: (.*)$/m.exec(output)?.[1];
  if (result.status !== 0 && !summary) throw new Error(output);
  return { failed: result.status !== 0, text: output, summary };
}

/** The first lines of `text` that fit in `budget` characters. */
function trim(text, budget) {
  if (text.length <= budget) return text;
  const lines = text.split("\n");
  const kept = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > budget) break;
    kept.push(line);
    used += line.length + 1;
  }
  const rest = lines.length - kept.length;
  return `${kept.join("\n")}\n… ${rest} more lines, in the job summary`;
}

/** Slack reads & < > as control characters, so they travel as entities. */
const slackEscape = (text) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function main() {
  const out = arg("--out");
  if (!out) {
    console.error("usage: api-drift-report.mjs --out DIR [--run-url URL]");
    return 2;
  }
  const runUrl = arg("--run-url", "(local run)");

  let planes;
  let drift;
  try {
    const missing = await unpublished();
    if (missing.length) {
      const line = `reference not published on staging yet, skipping (404: ${missing.join(", ")})`;
      mkdirSync(out, { recursive: true });
      writeFileSync(
        resolve(out, "summary.md"),
        `## API drift: skipped\n\n${line}\n`,
      );
      console.log(line);
      return 0;
    }
    planes = PLANES.map((plane) => renderPlane(plane, changelog(plane)));
    drift = sdkDrift();
  } catch (error) {
    console.error(`::error::${error.message.split("\n")[0]}`);
    console.error(error.message);
    return 2;
  }

  const changed = planes.some((plane) => plane.changed);
  const red = changed || drift.failed;
  const changelogText = planes.map((plane) => plane.text).join("\n\n");
  const driftText = drift.failed ? drift.text : "none";
  const summaryLines = [
    `SDK drift: ${drift.failed ? (drift.summary ?? "see the job summary") : "none"}`,
    ...planes.map((plane) => `Reference ${plane.header}`),
    runUrl,
  ];

  const body = red
    ? [
        summaryLines.join("\n"),
        `SDK drift:\n\`\`\`\n${trim(driftText, DRIFT_BUDGET)}\n\`\`\``,
        `Reference changelog:\n\`\`\`\n${planes
          .map((plane) => trim(plane.text, PLANE_BUDGET))
          .join("\n\n")}\n\`\`\``,
      ].join("\n\n")
    : runUrl;

  const summary = [
    `## API drift: ${red ? "red" : "green"}`,
    "",
    ...summaryLines.slice(0, -1).map((line) => `- ${line}`),
    "",
    "### SDK drift",
    "",
    "```",
    driftText,
    "```",
    "",
    "### Reference changelog",
    "",
    "```",
    changelogText,
    "```",
    "",
  ].join("\n");

  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, "state"), red ? "red\n" : "green\n");
  writeFileSync(resolve(out, "body.txt"), `${slackEscape(body)}\n`);
  writeFileSync(resolve(out, "summary.md"), summary);
  console.log(`API drift: ${red ? "red" : "green"}`);
  console.log(summaryLines.slice(0, -1).join("\n"));
  return 0;
}

process.exit(await main());
