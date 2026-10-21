/**
 * Builds the nightly API drift report that .github/workflows/api-contract.yml
 * posts to #main-build-alerts.
 *
 * Two reports, because they answer different questions:
 *
 * - The reference changelog: what changed in the published API since the
 *   snapshots in api-reference/ were taken, from oasdiff. Operations and fields
 *   added, removed or changed, with oasdiff's breaking verdict on each.
 * - The SDK drift: where this SDK's types disagree with the live reference,
 *   from scripts/check-api-contract.mjs, run as it is.
 *
 * Either one being non-empty makes the run red: SDK drift needs fixing, and a
 * changelog means the snapshots are behind even when the SDK happens to match.
 *
 * The report is written to --out as files the notify step reads:
 *
 *   state        red | green
 *   hash         sha256 of both full reports, so the notify step can tell a
 *                changed report from the same one again
 *   body.txt     the Slack message below its headline: summary, run link, and
 *                the agent prompt carrying both reports trimmed to fit
 *   summary.md   both reports in full, for the job summary
 *
 * Exits 0 when the report was built (red or green) and 2 when it could not be,
 * for example when the live reference did not answer: an outage is not drift,
 * and must not post or change the notify state.
 *
 * Run: node scripts/api-drift-report.mjs --out DIR [--run-url URL]
 * env: OASDIFF  the oasdiff binary (default: oasdiff on PATH)
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLANES = ["dataplane", "controlplane"];
const LIVE = (plane) => `https://docs.introspection.dev/openapi/${plane}.json`;
const SNAPSHOT = (plane) => resolve(ROOT, `api-reference/${plane}.json`);
const PROMPT = resolve(ROOT, ".github/api-drift-prompt.md");

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

/** Changes from the snapshot to the live reference, as oasdiff's JSON. */
function changelog(plane) {
  const result = spawnSync(
    process.env.OASDIFF || "oasdiff",
    ["changelog", SNAPSHOT(plane), LIVE(plane), "--format", "json"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(
      `oasdiff could not compare the ${plane} snapshot with ${LIVE(plane)}: ${
        result.error?.message ?? result.stderr.trim()
      }`,
    );
  }
  return JSON.parse(result.stdout || "[]");
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
          ? template(group).replace("…", group.values.join("`, `"))
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
 * The SDK drift as check-api-contract.mjs reports it, minus its `note:`
 * paragraphs: those are fields the API accepts that the SDK chose not to
 * expose, which the check itself does not count as drift.
 */
function sdkDrift() {
  const result = spawnSync(
    process.execPath,
    [resolve(ROOT, "scripts/check-api-contract.mjs")],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  const output = `${result.stdout}\n${result.stderr}`
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph && !paragraph.startsWith("note:"))
    .join("\n\n");
  if (/could not read the API reference/.test(output)) {
    throw new Error(output);
  }
  return { failed: result.status !== 0, text: output };
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

function main() {
  const out = arg("--out");
  if (!out) {
    console.error("usage: api-drift-report.mjs --out DIR [--run-url URL]");
    return 2;
  }
  const runUrl = arg("--run-url", "(local run)");

  let planes;
  let drift;
  try {
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
  const surfaces = drift.failed
    ? drift.text.split("\n\n").filter((p) => !p.startsWith("reference:")).length
    : 0;

  const summaryLines = [
    `SDK drift: ${surfaces ? `${surfaces} surfaces disagree with the live reference` : "none"}`,
    ...planes.map((plane) => `Reference ${plane.header}`),
    runUrl,
  ];

  const prompt = readFileSync(PROMPT, "utf8")
    .replace(/<!--[\s\S]*?-->\s*/, "")
    .replace("{{RUN_URL}}", runUrl)
    .replace("{{SDK_DRIFT}}", trim(driftText, DRIFT_BUDGET))
    .replace(
      "{{CHANGELOG}}",
      planes.map((plane) => trim(plane.text, PLANE_BUDGET)).join("\n\n"),
    )
    .trim();

  const body = red
    ? `${summaryLines.join("\n")}\n\nAgent prompt, ready to paste:\n\`\`\`\n${prompt}\n\`\`\``
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
  writeFileSync(
    resolve(out, "hash"),
    `${createHash("sha256").update(`${driftText}\n\n${changelogText}`).digest("hex")}\n`,
  );
  writeFileSync(resolve(out, "body.txt"), `${slackEscape(body)}\n`);
  writeFileSync(resolve(out, "summary.md"), summary);
  console.log(`API drift: ${red ? "red" : "green"}`);
  console.log(summaryLines.slice(0, -1).join("\n"));
  return 0;
}

process.exit(main());
