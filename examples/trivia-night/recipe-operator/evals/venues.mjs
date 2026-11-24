// Writes a night-1 and a night-2 Harbor task per venue profile in
// fakes/world/profiles.ts, and evals/venues.json, which the trivia-night page
// plans its runs from. Run with `pnpm evals:venues` from the example.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const COUNTRY = { au: "Australia", uk: "the UK", us: "the US" };

/**
 * @typedef {{ id: string, pub: string, city: string, region: "au" | "uk" | "us", teams: string[], stated: string[], level?: number }} Profile
 * @typedef {{ slug: string, label: string, profile: string, pub: string, city: string, region: Profile["region"], teams: string[], likes: string[], start_difficulty?: number }} Venue
 */

const list = (items) =>
  items.length > 1
    ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
    : (items[0] ?? "");

/** @param {Profile} profile @returns {Venue} */
export function venueOf(profile) {
  return {
    slug: profile.city
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, ""),
    label: `${profile.city} (${profile.region.toUpperCase()})`,
    profile: profile.id,
    pub: profile.pub,
    city: profile.city,
    region: profile.region,
    teams: profile.teams.slice(0, 2),
    likes: profile.stated,
    // The bank's difficulty (1-5) nearest the level this crowd gets two in three right.
    ...(typeof profile.level === "number"
      ? {
          start_difficulty: Math.min(5, Math.max(1, Math.round(profile.level))),
        }
      : {}),
  };
}

const taskToml = (name, description, venue) => `schema_version = "1.1"

[task]
name = "trivia-host/${name}"
description = "${description}"

[metadata]
case = "C3"
venue = "${venue.profile}"

[verifier]
timeout_sec = 120.0

[agent]
timeout_sec = 900.0

[environment]
build_timeout_sec = 600.0
cpus = 1
memory_mb = 2048

[environment.env]
ANTHROPIC_API_KEY = "\${ANTHROPIC_API_KEY:-}"

[[artifacts]]
source = "/workspace/memories"
destination = "memories"
`;

const compose = (venue) => `services:
  main:
    depends_on:
      fakes:
        condition: service_healthy
    volumes:
      - fakes-verifier:/opt/fakes-verifier:ro
  fakes:
    build:
      context: ../../../../fakes
    environment:
      EVAL_SIMULATE_SCENARIO: ${venue.profile}
      EVAL_SIMULATE_MANIFEST_DIR: /verifier
    volumes:
      - fakes-verifier:/verifier
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:7353/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"]
      interval: 1s
      retries: 30
volumes:
  fakes-verifier: {}
`;

const TEST_SH = `#!/bin/sh
set -u
mkdir -p /logs/verifier
node /tests/check.mjs
`;

const SOLVE_SH = `#!/bin/sh
exit 0
`;

const NIGHT1_CHECK = String.raw`import { existsSync, readFileSync, writeFileSync } from "node:fs";

const expected = JSON.parse(readFileSync(new URL("./expected.json", import.meta.url), "utf8"));
const state = await (await fetch("http://fakes:7353/trivia-bank/admin/state")).json();
const bank = state["trivia-bank"] ?? state;
const notesPath = "/workspace/memories/MEMORY.md";
const notes = existsSync(notesPath) ? readFileSync(notesPath, "utf8") : "";
const teams = expected.teams.map((t) => t.replace(/^the\s+/i, "").toLowerCase());
const scores = {
  night_started: (bank.nights?.length ?? 0) === 1 ? 1 : 0,
  round_fetched: (bank.asked?.length ?? 0) > 0 ? 1 : 0,
  notes_written: notes.trim() ? 1 : 0,
  notes_name_no_team: notes && !teams.some((t) => notes.toLowerCase().includes(t)) ? 1 : 0,
};
const reward = Object.values(scores).every((v) => v === 1) ? 1 : 0;
writeFileSync("/logs/verifier/reward.json", JSON.stringify({ reward, ...scores }));
console.log(JSON.stringify({ reward, ...scores, notes }, null, 2));
`;

const NIGHT2_CHECK = String.raw`import { existsSync, readFileSync, writeFileSync } from "node:fs";

const expected = JSON.parse(readFileSync(new URL("./expected.json", import.meta.url), "utf8"));
// The native adapter leaves an ATIF trajectory; the runtime adapter, Pi's event log.
const atif = "/logs/agent/trajectory.json";
let calls = [];
let text = "";
if (existsSync(atif)) {
  const steps = JSON.parse(readFileSync(atif, "utf8")).steps ?? [];
  calls = steps.flatMap((s) => (s.tool_calls ?? []).map((c) => ({ name: c.function_name, args: c.arguments ?? {} })));
  // Only what the agent said: the system prompt itself tells it to ask the country.
  text = steps.filter((s) => s.source === "agent").map((s) => s.message ?? "").join("\n");
} else {
  const log = readFileSync("/logs/agent/pi.jsonl", "utf8");
  text = log;
  calls = log.split("\n").flatMap((l) => {
    try {
      const e = JSON.parse(l);
      return e.type === "tool_execution_start" ? [{ name: e.toolName, args: e.args ?? {} }] : [];
    } catch { return []; }
  });
}
const fetches = calls.filter((c) => c.name.includes("next_questions"));
const notes = existsSync("/workspace/memories/MEMORY.md") ? readFileSync("/workspace/memories/MEMORY.md", "utf8") : "";
const teams = expected.teams.map((t) => t.replace(/^the\s+/i, "").toLowerCase());
const scores = {
  fetched_a_round: fetches.length > 0 ? 1 : 0,
  own_region_or_global_only: fetches.length > 0 && fetches.every((c) => [expected.region, "global"].includes(c.args.region)) ? 1 : 0,
  did_not_ask_country: /which country|what country/i.test(text) ? 0 : 1,
  notes_kept: notes.trim() && !teams.some((t) => notes.toLowerCase().includes(t)) ? 1 : 0,
};
const reward = Object.values(scores).every((v) => v === 1) ? 1 : 0;
writeFileSync("/logs/verifier/reward.json", JSON.stringify({ reward, ...scores }));
console.log(JSON.stringify({ reward, ...scores, expected_region: expected.region, fetches: fetches.map((c) => c.args), notes }, null, 2));
`;

/**
 * Each file of a venue's two tasks, keyed by its path under evals/harbor.
 * @param {Venue} venue
 * @returns {Record<string, string>}
 */
export function taskFiles(venue) {
  const [a, b] = venue.teams;
  const expected = `${JSON.stringify(
    {
      venue: venue.profile,
      region: venue.region,
      teams: venue.teams,
      likes: venue.likes,
      ...(venue.start_difficulty === undefined
        ? {}
        : { start_difficulty: venue.start_difficulty }),
    },
    null,
    2,
  )}\n`;
  const likes = venue.likes.length
    ? ` The crowd's keen on ${list(venue.likes)}.`
    : "";
  const night1 = `night1-${venue.slug}`;
  const night2 = `night2-${venue.slug}`;
  return {
    [`${night1}/instruction.md`]: `We're in ${venue.city}, in ${COUNTRY[venue.region]}, and it's our first trivia night with you. Two teams tonight: ${a} and ${b}.${likes} We only have time for one round, so plan the night, fetch that round and read it out. I'll mark it myself, so you won't get a sheet back. When you've read it out, that's the end of tonight: leave your notes ready for next week, as you would after the last round.\n`,
    [`${night1}/task.toml`]: taskToml(
      night1,
      `A new venue's first night (${venue.pub}, ${venue.city}): the host plays a round against the bank fake and leaves its notes in memories/MEMORY.md`,
      venue,
    ),
    [`${night1}/environment/docker-compose.yaml`]: compose(venue),
    [`${night1}/tests/test.sh`]: TEST_SH,
    [`${night1}/tests/check.mjs`]: NIGHT1_CHECK,
    [`${night1}/tests/expected.json`]: expected,
    [`${night1}/solution/solve.sh`]: SOLVE_SH,
    [`${night2}/instruction.md`]: `Evening! Same teams as last week: ${a} and ${b}. One round again tonight: plan it, fetch it and read it out. I'll mark it myself. After that we're done, so leave your notes ready for next week.\n`,
    [`${night2}/task.toml`]: taskToml(
      night2,
      `The second night at ${venue.pub}, ${venue.city}, on the platform: the notes come from the identity's own memory`,
      venue,
    ),
    [`${night2}/environment/docker-compose.yaml`]: compose(venue),
    [`${night2}/tests/test.sh`]: TEST_SH,
    [`${night2}/tests/check.mjs`]: NIGHT2_CHECK,
    [`${night2}/tests/expected.json`]: expected,
    [`${night2}/solution/solve.sh`]: SOLVE_SH,
  };
}

/** JSON as prettier prints it: a short array of strings on one line. */
const json = (value) =>
  JSON.stringify(value, null, 2).replace(
    /^( *)("\w+": )\[\n((?: *"[^"\n]*",?\n)+) *\]/gm,
    (whole, indent, key, items) => {
      const line = `${indent}${key}[${items
        .trim()
        .split(/,?\n\s*/)
        .join(", ")}]`;
      return line.length <= 80 ? line : whole;
    },
  );

/**
 * Writes every venue's tasks under harborDir and the manifest, removing the
 * tasks of venues the previous manifest listed and this one does not.
 * @param {string} harborDir @param {string} manifestFile @param {Profile[]} profiles
 * @returns {Venue[]}
 */
export function writeVenues(harborDir, manifestFile, profiles) {
  const venues = profiles.map(venueOf);
  const slugs = new Set(venues.map((v) => v.slug));
  if (slugs.size !== venues.length)
    throw new Error("two venue profiles share a city");
  if (existsSync(manifestFile))
    for (const old of JSON.parse(readFileSync(manifestFile, "utf8")))
      if (!slugs.has(old.slug))
        for (const night of ["night1", "night2"])
          rmSync(path.join(harborDir, `${night}-${old.slug}`), {
            recursive: true,
            force: true,
          });
  for (const venue of venues)
    for (const [file, content] of Object.entries(taskFiles(venue))) {
      const target = path.join(harborDir, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content, {
        mode: file.endsWith(".sh") ? 0o755 : 0o644,
      });
    }
  writeFileSync(manifestFile, `${json(venues)}\n`);
  return venues;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const { ALL } = await import(
    pathToFileURL(path.join(here, "../fakes/world/profiles.ts")).href
  );
  const venues = writeVenues(
    path.join(here, "harbor"),
    path.join(here, "venues.json"),
    ALL,
  );
  console.log(
    `wrote ${venues.length * 2} tasks: ${venues.map((v) => v.label).join(", ")}`,
  );
}
