// Writes a night-0, night-1 and night-2 Harbor task per pub (PAGE and HELDOUT in
// fakes/world/profiles.ts) and crowd size, for a local Harbor run, and evals/venues.json and
// evals/heldout.json, which the trivia-night page and the committed dynamic tasks (harbor/night0,
// night1, night2) read each pub from. Each venue's tastes, level and best decades are read off its
// crowd (fakes/world/crowd.ts), and night 2's teams are about four in five of night 1's with new
// teams filling the rest. Every generated task's tests/ carries a copy of trivia-check.mjs and
// trivia-tasks.mjs, since Harbor copies only tests/ into the sandbox. Run with
// `node recipe-operator/evals/venues.mjs [dir]` (evals/harbor by default, git-ignored).
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  bankEnvironment,
  DEFAULT_TEAMS,
  expectedFor,
  instructionFor,
  perfectNotes,
  TEAM_SIZES,
} from "./trivia-tasks.mjs";

export { DEFAULT_TEAMS, TEAM_SIZES, perfectNotes };

/** A venue's task for a night and crowd size, such as night1-leeds or night2-leeds-t8. */
export const taskName = (night, slug, teams = DEFAULT_TEAMS) =>
  `night${night}-${slug}${teams === DEFAULT_TEAMS ? "" : `-t${teams}`}`;

/**
 * @typedef {{ id: string, pub: string, city: string, region: "au" | "uk" | "us", teams: string[], stated: string[], level?: number, enjoy?: Record<string, number>, decades?: string[], night2Teams?: Record<number, string[]> }} Profile
 * @typedef {{ slug: string, label: string, profile: string, pub: string, city: string, region: Profile["region"], teams: string[], night2_teams: Record<string, string[]>, liked: string[], disliked: string[], hinted: string[], best_decades?: string[], target_difficulty?: number }} Venue
 */

/**
 * The crowd's two favourite genres and its least favourite, from the profile's
 * enjoyment; a profile without enjoyment falls back to the genres the trivia
 * master states.
 * @param {Profile} profile
 */
function tastesOf(profile) {
  if (!profile.enjoy) return { liked: profile.stated, disliked: [] };
  const ranked = Object.entries(profile.enjoy).sort((a, b) => b[1] - a[1]);
  return {
    liked: ranked.slice(0, 2).map(([g]) => g),
    disliked: [ranked.at(-1)[0]],
  };
}

/**
 * @param {Profile} profile
 * @param {string} [prefix] put before the city's slug, such as "held-" for a held-out pub
 * @returns {Venue}
 */
export function venueOf(profile, prefix = "") {
  return {
    slug: `${prefix}${profile.city
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")}`,
    label: `${profile.city} (${profile.region.toUpperCase()})`,
    profile: profile.id,
    pub: profile.pub,
    city: profile.city,
    region: profile.region,
    teams: profile.teams.slice(0, Math.max(...TEAM_SIZES)),
    // Night 2's teams for each crowd size; a profile without turnover keeps night 1's.
    night2_teams: Object.fromEntries(
      TEAM_SIZES.map((size) => [
        String(size),
        profile.night2Teams?.[size] ?? profile.teams.slice(0, size),
      ]),
    ),
    ...tastesOf(profile),
    // What night 1's instruction tells the host the crowd loves: the trivia master's first stated genre.
    hinted: profile.stated.slice(0, 1),
    ...(profile.decades ? { best_decades: profile.decades } : {}),
    // The bank's difficulty (1-5) nearest the level this crowd gets about 65% right on its favourites.
    ...(typeof profile.level === "number"
      ? {
          target_difficulty: Math.min(
            5,
            Math.max(1, Math.round(profile.level)),
          ),
        }
      : {}),
  };
}

/** JSON as prettier prints it: a short array of strings on one line. */
const json = (value) =>
  JSON.stringify(value, null, 2).replace(
    /^( *)("\w+": )\[\n((?: *"[^"\n]*",?\n)+) *\](,?)/gm,
    (whole, indent, key, items, comma) => {
      const line = `${indent}${key}[${items
        .trim()
        .split(/,?\n\s*/)
        .join(", ")}]${comma}`;
      return line.length <= 80 ? line : whole;
    },
  );

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

/** A generated task's compose: the bank sidecar, built from fakes/, with the trial's settings. */
const compose = (venue, night, teams) => `services:
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
${Object.entries(bankEnvironment(venue, night, teams))
  .map(([k, v]) => `      ${k}: "${v}"`)
  .join("\n")}
    volumes:
      - fakes-verifier:/verifier
    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:7353/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))",
        ]
      interval: 1s
      retries: 30
volumes:
  fakes-verifier: {}
`;

// Runs under Harbor (tests in /tests, logs in /logs/verifier) and natively, where the runtime
// runs it from the task's own tests folder and names the logs folder in LOGS_DIR.
const TEST_SH = `#!/bin/sh
set -u
here=$(dirname "$0")
mkdir -p "\${LOGS_DIR:-/logs/verifier}"
node "$here/check.mjs"
`;

const SOLVE_SH = `#!/bin/sh
exit 0
`;

/** A generated task's check: the shared verifier, with the truth baked in beside it. */
const CHECK = (night) => `import { readFileSync } from "node:fs";
import { check } from "./trivia-check.mjs";

const here = (file) => readFileSync(new URL(file, import.meta.url), "utf8");
await check(${
  night === 0
    ? `{ night: 0, seeded: here("./notes.md") }`
    : `{ night: ${night}, expected: JSON.parse(here("./expected.json")) }`
});
`;

/**
 * Each file of a venue's tasks for a crowd of `size`, keyed by its path under the output folder.
 * @param {Venue} venue @param {number} [size]
 * @returns {Record<string, string>}
 */
export function taskFiles(venue, size = DEFAULT_TEAMS) {
  const night1 = taskName(1, venue.slug, size);
  const night2 = taskName(2, venue.slug, size);
  const night0 = taskName(0, venue.slug);
  const notes = perfectNotes(venue);
  // Night 0 has no crowd, so one task serves every crowd size.
  const seed =
    size === DEFAULT_TEAMS
      ? {
          [`${night0}/instruction.md`]: instructionFor(venue, 0),
          [`${night0}/task.toml`]: taskToml(
            night0,
            `Seeds the venue's true notes (${venue.pub}, ${venue.city}) in memories/MEMORY.md for the perfect-notes night 2; no quiz is played`,
            venue,
          ),
          [`${night0}/environment/docker-compose.yaml`]: compose(venue, 0),
          [`${night0}/tests/test.sh`]: TEST_SH,
          [`${night0}/tests/check.mjs`]: CHECK(0),
          [`${night0}/tests/notes.md`]: notes,
          [`${night0}/solution/solve.sh`]: `#!/bin/sh\nmkdir -p /workspace/memories\ncat > /workspace/memories/MEMORY.md <<'NOTES'\n${notes}NOTES\n`,
        }
      : {};
  return {
    ...seed,
    [`${night1}/instruction.md`]: instructionFor(venue, 1, size),
    [`${night1}/task.toml`]: taskToml(
      night1,
      `A new venue's first night (${venue.pub}, ${venue.city}): the host plays six rounds to a simulated crowd and leaves its notes in memories/MEMORY.md`,
      venue,
    ),
    [`${night1}/environment/docker-compose.yaml`]: compose(venue, 1, size),
    [`${night1}/tests/test.sh`]: TEST_SH,
    [`${night1}/tests/check.mjs`]: CHECK(1),
    [`${night1}/tests/expected.json`]: `${json(expectedFor(venue, 1, size))}\n`,
    [`${night1}/solution/solve.sh`]: SOLVE_SH,
    [`${night2}/instruction.md`]: instructionFor(venue, 2, size),
    [`${night2}/task.toml`]: taskToml(
      night2,
      `The second night at ${venue.pub}, ${venue.city}: six rounds to a simulated crowd, most of it night 1's teams, pitched from the identity's own memory or from nothing`,
      venue,
    ),
    [`${night2}/environment/docker-compose.yaml`]: compose(venue, 2, size),
    [`${night2}/tests/test.sh`]: TEST_SH,
    [`${night2}/tests/check.mjs`]: CHECK(2),
    [`${night2}/tests/expected.json`]: `${json(expectedFor(venue, 2, size))}\n`,
    [`${night2}/solution/solve.sh`]: SOLVE_SH,
  };
}

/**
 * Writes every venue's tasks under harborDir and the manifest, removing the
 * tasks of venues the previous manifest listed and this one does not.
 * @param {string} harborDir @param {string} manifestFile @param {Profile[]} profiles
 * @param {string} [prefix] before each venue's slug, such as "held-"
 * @returns {Venue[]}
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

export function writeVenues(harborDir, manifestFile, profiles, prefix = "") {
  const venues = profiles.map((profile) => venueOf(profile, prefix));
  const slugs = new Set(venues.map((v) => v.slug));
  if (slugs.size !== venues.length)
    throw new Error("two venue profiles share a city");
  if (existsSync(manifestFile))
    for (const old of JSON.parse(readFileSync(manifestFile, "utf8")))
      if (!slugs.has(old.slug))
        for (const night of [0, 1, 2])
          for (const size of TEAM_SIZES)
            rmSync(path.join(harborDir, taskName(night, old.slug, size)), {
              recursive: true,
              force: true,
            });
  for (const venue of venues)
    for (const [file, content] of TEAM_SIZES.flatMap((size) =>
      Object.entries(taskFiles(venue, size)),
    )) {
      const target = path.join(harborDir, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content, {
        mode: file.endsWith(".sh") ? 0o755 : 0o644,
      });
    }
  // Harbor copies only tests/ into the sandbox, so each check carries the shared modules.
  for (const dir of new Set(
    venues.flatMap((venue) =>
      TEAM_SIZES.flatMap((size) =>
        Object.keys(taskFiles(venue, size))
          .filter((file) => file.endsWith("/tests/check.mjs"))
          .map((file) => path.join(harborDir, path.dirname(file))),
      ),
    ),
  ))
    for (const shared of ["trivia-check.mjs", "trivia-tasks.mjs"])
      copyFileSync(path.join(HERE, shared), path.join(dir, shared));
  writeFileSync(manifestFile, `${json(venues)}\n`);
  return venues;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const world = await import(
    pathToFileURL(path.join(here, "../fakes/world/profiles.ts")).href
  );
  // Night 2's teams for each crowd size, turnover included, from the world itself.
  const withTurnover = (profiles) =>
    profiles.map((p) => ({
      ...p,
      night2Teams: Object.fromEntries(
        TEAM_SIZES.map((size) => [size, world.crowd(p, size, 2)]),
      ),
    }));
  // The per-pub tasks are generated for a local run, never committed (.gitignore): pass a folder to
  // write them elsewhere.
  const harbor = path.resolve(process.argv[2] ?? path.join(here, "harbor"));
  const venues = writeVenues(
    harbor,
    path.join(here, "venues.json"),
    withTurnover(world.PAGE),
  );
  // The held-out pubs' tasks, by count only: their tastes stay out of sight until the frozen run.
  const held = writeVenues(
    harbor,
    path.join(here, "heldout.json"),
    withTurnover(world.HELDOUT),
    "held-",
  );
  console.log(
    `wrote ${venues.length * (1 + 2 * TEAM_SIZES.length)} tasks: ${venues.map((v) => v.label).join(", ")}; and ${held.length * (1 + 2 * TEAM_SIZES.length)} held-out tasks`,
  );
}
