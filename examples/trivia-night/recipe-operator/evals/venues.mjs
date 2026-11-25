// Writes a night-1 and a night-2 Harbor task per page venue profile (PAGE in
// fakes/world/profiles.ts) and crowd size, and evals/venues.json, which the trivia-night page
// plans its runs from. Each venue's tastes, level and best decades are read off its crowd
// (fakes/world/crowd.ts), and night 2's teams are about four in five of night 1's with new
// teams filling the rest. Run with `pnpm evals:venues` from the example.
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
const COUNT = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
];
// The crowd in the room is the profile's first n teams, as the bank's crowd answers
// (EVAL_SIMULATE_TEAMS); 5 keeps the unsuffixed task names, the others end -t<n>.
export const TEAM_SIZES = [3, 5, 8];
export const DEFAULT_TEAMS = 5;

/** A venue's task for a night and crowd size, such as night1-leeds or night2-leeds-t8. */
export const taskName = (night, slug, teams = DEFAULT_TEAMS) =>
  `night${night}-${slug}${teams === DEFAULT_TEAMS ? "" : `-t${teams}`}`;

/** A night's rounds and questions per round. */
export const ROUNDS = 6;
export const PER_ROUND = 4;

/**
 * @typedef {{ id: string, pub: string, city: string, region: "au" | "uk" | "us", teams: string[], stated: string[], level?: number, enjoy?: Record<string, number>, decades?: string[], night2Teams?: Record<number, string[]> }} Profile
 * @typedef {{ slug: string, label: string, profile: string, pub: string, city: string, region: Profile["region"], teams: string[], night2_teams: Record<string, string[]>, liked: string[], disliked: string[], hinted: string[], best_decades?: string[], target_difficulty?: number }} Venue
 */

const list = (items) =>
  items.length > 1
    ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
    : (items[0] ?? "");

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

// Each night runs in its own sandbox from a fresh bank; EVAL_SIMULATE_NIGHT gives it that night's share of the venue's questions,
// split across the series' two nights (EVAL_SIMULATE_SERIES_NIGHTS).
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
      EVAL_SIMULATE_SCENARIO: crowd-${venue.profile}
      EVAL_SIMULATE_NIGHT: "${night}"
      EVAL_SIMULATE_SERIES_NIGHTS: "2"
      EVAL_SIMULATE_TEAMS: "${teams}"
      EVAL_SIMULATE_MANIFEST_DIR: /verifier
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

/**
 * The notes a host would leave had it learned everything night 1's crowd could
 * show: the venue's true country, favourites, least favourite genre, starting
 * level and best decades, in a host's style, about the crowd and never a team.
 * Night 0 seeds them for the "perfect notes" night 2.
 * @param {Venue} venue
 */
export function perfectNotes(venue) {
  const level = venue.target_difficulty ?? 3;
  return [
    "# Venue notes",
    "",
    `- Country: ${COUNTRY[venue.region].replace(/^the /, "")} (${venue.city}). Use region \`${venue.region}\` (or \`global\`).`,
    `- Genres: the crowd loves ${list(venue.liked)}. Plan about 4 of ${ROUNDS} rounds on those and keep the other genres in rotation.`,
    ...(venue.disliked.length
      ? [
          `- They don't enjoy ${list(venue.disliked).replace(/ and /, " or ")}: keep ${venue.disliked.length === 1 ? "it" : "those"} rare.`,
        ]
      : []),
    `- Difficulty: start next night at ${level}. Aim for about two in three right and adjust from round_summary.`,
    ...(venue.best_decades?.length
      ? [`- Eras: the crowd knows the ${list(venue.best_decades)} best.`]
      : []),
    "",
  ].join("\n");
}

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

// The host's steps, for the page: its tool calls in order, with short arguments and results,
// and its last message, read from the GenAI spans the runtime keeps in the sandbox (the agent's
// session is not on disk), and printed in the verifier's report beside the numeric reward.json.
// The memory the runtime loads before the first turn is in no span; the page shows it from the
// night before's notes.
export const HOST_STEPS = String.raw`const SECRET =
  /(sk-[A-Za-z0-9_-]{16,}|intro_[a-z]+_[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|Bearer [A-Za-z0-9._-]{16,})/g;
const clip = (text, max) => {
  const clean = String(text).replace(SECRET, "[redacted]");
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean;
};
const shorten = (value, depth = 0) =>
  typeof value === "string"
    ? clip(value, depth ? 160 : 4000)
    : Array.isArray(value)
      ? value.slice(0, 40).map((v) => shorten(v, depth + 1))
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value).map(([k, v]) => [k, shorten(v, depth + 1)]),
          )
        : value;
const resultText = (raw) => {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "string") return parsed;
    const parts = Array.isArray(parsed?.content) ? parsed.content : [];
    return parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("");
  } catch {
    return String(raw ?? "");
  }
};
const MEMORY = /(^|\/)memories\/[^/]+\.md$/;
const step = (id, name, rawArgs, result, error) => {
  let args = rawArgs ?? {};
  if (typeof args === "string")
    try {
      args = JSON.parse(args || "{}");
    } catch {
      args = { raw: args };
    }
  const memory = typeof args.path === "string" && MEMORY.test(args.path);
  return {
    id,
    name,
    arguments: memory ? shorten(args) : shorten(args, 1),
    result: clip(result, memory ? 4000 : 240),
    error,
  };
};
function hostSteps() {
  const file =
    process.env.PI_RECIPE_GENAI_SPANS_FILE || "/tmp/introspection/genai-spans.json";
  if (!existsSync(file)) return { steps_error: "no session record in the sandbox" };
  const spans = (JSON.parse(readFileSync(file, "utf8")).data ?? [])
    .filter((s) => s.attributes?.gen_ai?.agent?.id === "root")
    .sort((a, b) => String(a.start_time).localeCompare(String(b.start_time)));
  const steps = [];
  let plan = "";
  for (const span of spans) {
    const gen = span.attributes.gen_ai;
    if (gen.operation?.name === "execute_tool" && gen.tool?.call)
      steps.push(
        step(
          gen.tool.call.id,
          gen.tool.name,
          gen.tool.call.arguments,
          resultText(gen.tool.call.result),
          span.status?.code === "Error",
        ),
      );
    for (const message of gen.output?.messages ?? [])
      for (const part of message.parts ?? [])
        if (part.type === "text" && part.content?.trim()) plan = part.content;
  }
  return { steps: steps.slice(0, 120), plan: clip(plan, 2000) };
}
let host;
try {
  host = hostSteps();
} catch (error) {
  host = { steps_error: clip(error?.message ?? error, 200) };
}
// Harbor reads every reward.json value as a reward in [0, 1], so raw counts (rounds_played,
// lead_changes_count) stay out of it. The printed report, which the platform keeps as the log,
// carries everything else: measures, rounds, the host's steps and the crowd's true tastes.
const writeResult = (result, report) => {
  const rewards = Object.fromEntries(
    Object.entries(result).filter(
      ([, v]) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1,
    ),
  );
  const logs = process.env.LOGS_DIR || "/logs/verifier";
  writeFileSync(logs + "/reward.json", JSON.stringify(rewards));
  const tastes = typeof expected === "undefined" ? {} : { tastes: expected };
  console.log(JSON.stringify({ ...report, ...host, ...tastes }));
};`;

// What both nights' verifiers read from the bank: each round (one next_questions call) with its
// share right, in the order played, and the crowd's measures over them.
const CROWD_MEASURES = String.raw`const state = await (
  await fetch("http://fakes:7353/trivia-bank/admin/state")
).json();
const bank = state["trivia-bank"] ?? state;
// Only MEMORY.md is loaded on the next night; another note file is read only when MEMORY.md names it.
const memories = "/workspace/memories";
const noteFiles = existsSync(memories)
  ? readdirSync(memories).filter((f) => f.endsWith(".md"))
  : [];
const read = (f) => readFileSync(memories + "/" + f, "utf8");
const notes = noteFiles.includes("MEMORY.md") ? read("MEMORY.md") : "";
const allNotes = noteFiles.map(read).join("\n").toLowerCase();
const notesIndexed = noteFiles.every((f) => f === "MEMORY.md" || notes.includes(f))
  ? 1
  : 0;
const TARGET = 0.65;
const BAND = [0.55, 0.75];
const asked = bank.asked ?? [];
const marks = bank.marks ?? [];
const byRound = new Map();
for (const a of asked)
  byRound.set(a.week + "/" + a.request, [
    ...(byRound.get(a.week + "/" + a.request) ?? []),
    a,
  ]);
const roundMarks = [];
const fetches = [...byRound.values()].map((qs, i) => {
  const ids = new Set(qs.map((q) => q.question_id));
  const marked = marks.filter((m) => ids.has(m.question_id));
  roundMarks.push(marked);
  const count = (g) => qs.filter((q) => q.genre === g).length;
  const regions = [...new Set(qs.map((q) => q.region))];
  return {
    round: i + 1,
    genre: qs.map((q) => q.genre).sort((a, b) => count(b) - count(a))[0],
    difficulty:
      Math.round(
        (qs.reduce((s, q) => s + (q.difficulty ?? 0), 0) / qs.length) * 10,
      ) / 10,
    region: regions.length === 1 ? regions[0] : regions.join("+"),
    count: qs.length,
    correct_rate: marked.length
      ? marked.filter((m) => m.correct).length / marked.length
      : null,
  };
});
const round2 = (x) => Math.round(x * 100) / 100;
// Each round as it was played, for reading: every question with its answer and each team's mark.
const rounds = [...byRound.values()].map((qs, i) => ({
  ...fetches[i],
  correct_rate:
    fetches[i].correct_rate === null ? null : round2(fetches[i].correct_rate),
  questions: qs.map((q) => ({
    text: q.text ?? null,
    ...(q.options ? { options: q.options } : {}),
    answer: q.answer ?? null,
    marks: roundMarks[i]
      .filter((m) => m.question_id === q.question_id)
      .map((m) => ({ team: m.team, answer: m.answer ?? "", correct: !!m.correct })),
  })),
}));
const rated = fetches.filter((f) => f.correct_rate !== null);
// The standings after each round, and who leads: a tie at the top keeps the leader it had.
const points = new Map();
let leader = null;
let leadChanges = 0;
for (const [i, marked] of roundMarks.entries()) {
  for (const m of marked)
    points.set(m.team, (points.get(m.team) ?? 0) + (m.correct ? 1 : 0));
  if (!points.size) continue;
  const top = Math.max(...points.values());
  const leaders = [...points.keys()]
    .filter((t) => points.get(t) === top)
    .sort();
  const next = leaders.includes(leader) ? leader : leaders[0];
  if (i > 0 && leader !== null && next !== leader) leadChanges += 1;
  leader = next;
}
const finals = [...points.values()].sort((a, b) => b - a);
const [first = 0, second = 0] = finals;
const measures = {};
if (rated.length) {
  measures.pitch_miss = round2(
    rated.reduce((s, f) => s + Math.abs(f.correct_rate - TARGET), 0) /
      rated.length,
  );
  measures.in_band = round2(
    rated.filter((f) => f.correct_rate >= BAND[0] && f.correct_rate <= BAND[1])
      .length / rated.length,
  );
  measures.close_finish = round2((first - second) / asked.length);
  measures.bottom_share = first ? round2(finals.at(-1) / first) : 0;
  measures.lead_changes_count = leadChanges;
  if (roundMarks.length > 1)
    measures.lead_changes = round2(leadChanges / (roundMarks.length - 1));
}
if (fetches.length) {
  // The primary measure: rounds both in a favourite genre and 55-75% right, out of the
  // night's ${ROUNDS}, so a host that stops early scores its unplayed rounds as not good.
  measures.good_rounds = round2(
    fetches.filter(
      (f) =>
        expected.liked.includes(f.genre) &&
        f.correct_rate !== null &&
        f.correct_rate >= BAND[0] &&
        f.correct_rate <= BAND[1],
    ).length / Math.max(${ROUNDS}, fetches.length),
  );
  measures.favourite_genre = round2(
    fetches.filter((f) => expected.liked.includes(f.genre)).length /
      Math.max(${ROUNDS}, fetches.length),
  );
  measures.right_region = asked.every((a) =>
    [expected.region, "global"].includes(a.region),
  )
    ? 1
    : 0;
  // Whether the night opened at the right level, before any of tonight's marks could guide it.
  if (fetches[0].correct_rate !== null)
    measures.first_round_in_band =
      fetches[0].correct_rate >= BAND[0] && fetches[0].correct_rate <= BAND[1]
        ? 1
        : 0;
}
measures.rounds_played = fetches.length;
const round_rates = fetches.map((f) =>
  f.correct_rate === null ? null : round2(f.correct_rate),
);
`;

const NIGHT1_CHECK = String.raw`// Night 1's checks (reward 1 when all are 1): night_started, round_fetched,
// notes_written, notes_name_no_team (in any note file), notes_indexed (every note file named in MEMORY.md). The crowd's measures are printed too,
// as on night 2, for comparison: good_rounds, pitch_miss, in_band,
// close_finish, lead_changes, bottom_share, favourite_genre, right_region,
// and round_rates (each round's share right, in the order played).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const expected = JSON.parse(
  readFileSync(new URL("./expected.json", import.meta.url), "utf8"),
);
${CROWD_MEASURES}
${HOST_STEPS}
const teams = expected.teams.map((t) =>
  t.replace(/^the\s+/i, "").toLowerCase(),
);
const scores = {
  night_started: (bank.nights?.length ?? 0) === 1 ? 1 : 0,
  round_fetched: (bank.asked?.length ?? 0) > 0 ? 1 : 0,
  notes_written: notes.trim() ? 1 : 0,
  notes_name_no_team:
    notes && !teams.some((t) => allNotes.includes(t)) ? 1 : 0,
  notes_indexed: notesIndexed,
};
const reward = Object.values(scores).every((v) => v === 1) ? 1 : 0;
writeResult(
  { reward, ...scores },
  { reward, ...scores, ...measures, round_rates, fetches, rounds, notes },
);
`;

const NIGHT0_CHECK = String.raw`// Night 0's one check: memories/MEMORY.md holds exactly the given notes
// (tests/notes.md), so the night 2 after it starts from known-perfect notes.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const clean = (text) => text.replace(/\r\n/g, "\n").trim();
const want = clean(
  readFileSync(new URL("./notes.md", import.meta.url), "utf8"),
);
const notesPath = "/workspace/memories/MEMORY.md";
const notes = existsSync(notesPath) ? readFileSync(notesPath, "utf8") : "";
${HOST_STEPS}
const scores = { notes_seeded: clean(notes) === want ? 1 : 0 };
const reward = scores.notes_seeded;
writeResult({ reward, ...scores }, { reward, ...scores, notes });
`;

const NIGHT2_CHECK = String.raw`// Night 2's measures, from the bank's record of the crowd's answers:
// good_rounds (share of rounds in a favourite genre and 55-75% right; the
// primary measure), pitch_miss (mean |share right - 0.65| over rounds; lower is better),
// in_band (share of rounds with 55-75% right), close_finish (the gap between
// the top two teams as a share of the points on offer; lower is closer),
// lead_changes (times the lead changed hands, as a share of the chances it had),
// bottom_share (the last team's points as a share of the winner's),
// favourite_genre (share of rounds in a genre the crowd loves), first_round_in_band
// (1 when the first round landed 55-75% right), right_region
// (every question the venue's country or global), round_rates (each round's
// share right), plus fetched_a_round, notes_kept (MEMORY.md written, and no
// note file naming a team from either night) and notes_indexed (every note file
// named in MEMORY.md). Reward is 1 when in_band is at least 0.5.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const expected = JSON.parse(
  readFileSync(new URL("./expected.json", import.meta.url), "utf8"),
);
${CROWD_MEASURES}
${HOST_STEPS}
const teams = [
  ...new Set([...expected.teams, ...(expected.night1_teams ?? [])]),
].map((t) => t.replace(/^the\s+/i, "").toLowerCase());
const scores = {
  fetched_a_round: fetches.length > 0 ? 1 : 0,
  notes_kept: notes.trim() && !teams.some((t) => allNotes.includes(t)) ? 1 : 0,
  notes_indexed: notesIndexed,
  ...measures,
};
const reward =
  fetches.length >= ${ROUNDS} && (measures.in_band ?? 0) >= 0.5 ? 1 : 0;
writeResult(
  { reward, ...scores },
  {
    reward,
    ...scores,
    round_rates,
    liked: expected.liked,
    fetches,
    rounds,
    notes,
  },
);`;

/**
 * Each file of a venue's two tasks for a crowd of `size`, keyed by its path under evals/harbor.
 * @param {Venue} venue @param {number} [size]
 * @returns {Record<string, string>}
 */
export function taskFiles(venue, size = DEFAULT_TEAMS) {
  const crowd = venue.teams.slice(0, size);
  const later = venue.night2_teams?.[String(size)] ?? crowd;
  const back = later.filter((t) => crowd.includes(t));
  const fresh = later.filter((t) => !crowd.includes(t));
  const teams = list(crowd);
  const count = COUNT[crowd.length] ?? String(crowd.length);
  const Count = count[0].toUpperCase() + count.slice(1);
  const Later = (COUNT[later.length] ?? String(later.length)).replace(
    /^./,
    (c) => c.toUpperCase(),
  );
  // The truth night 1's crowd shows, for both nights: notes are graded on what a host could have learned.
  const expectedFor = (tonight, extra = {}) =>
    `${json({
      venue: venue.profile,
      region: venue.region,
      teams: tonight,
      ...extra,
      liked: venue.liked,
      disliked: venue.disliked,
      hinted: venue.hinted,
      ...(venue.best_decades ? { best_decades: venue.best_decades } : {}),
      ...(venue.target_difficulty === undefined
        ? {}
        : { target_difficulty: venue.target_difficulty }),
    })}\n`;
  const night2Teams = fresh.length
    ? `${Later} teams tonight here in ${venue.city}: ${list(later)}. ${list(back)} ${back.length === 1 ? "was" : "were"} here last week; ${list(fresh)} ${fresh.length === 1 ? "is" : "are"} new.`
    : `Same ${count} teams as last week here in ${venue.city}: ${teams}.`;
  // Only one favourite is hinted: the host learns the rest, and the level, from round_summary.
  const loved = venue.hinted.length
    ? ` From what I've seen, this crowd loves ${list(venue.hinted)}.`
    : "";
  const rounds = `The bank records the crowd's answers as you serve each round, so you won't get a sheet back: after each round, check round_summary to see how they did. I won't reply until the night is over, so run all six rounds straight through in this one go without waiting for me.`;
  const night1 = taskName(1, venue.slug, size);
  const night2 = taskName(2, venue.slug, size);
  const night0 = taskName(0, venue.slug);
  const notes = perfectNotes(venue);
  // Night 0 has no crowd, so one task serves every crowd size.
  const seed =
    size === DEFAULT_TEAMS
      ? {
          [`${night0}/instruction.md`]: `Before next week's night here in ${venue.city}, the trivia master has written up notes on the venue for you to keep. There's no quiz tonight, so don't start a night or fetch any questions: just replace memories/MEMORY.md with exactly the notes between the lines below, word for word, and nothing else.\n\n---\n\n${notes}\n---\n`,
          [`${night0}/task.toml`]: taskToml(
            night0,
            `Seeds the venue's true notes (${venue.pub}, ${venue.city}) in memories/MEMORY.md for the perfect-notes night 2; no quiz is played`,
            venue,
          ),
          [`${night0}/environment/docker-compose.yaml`]: compose(
            venue,
            1,
            DEFAULT_TEAMS,
          ),
          [`${night0}/tests/test.sh`]: TEST_SH,
          [`${night0}/tests/check.mjs`]: NIGHT0_CHECK,
          [`${night0}/tests/notes.md`]: notes,
          [`${night0}/solution/solve.sh`]: `#!/bin/sh\nmkdir -p /workspace/memories\ncat > /workspace/memories/MEMORY.md <<'NOTES'\n${notes}NOTES\n`,
        }
      : {};
  return {
    ...seed,
    [`${night1}/instruction.md`]: `We're in ${venue.city}, in ${COUNTRY[venue.region]}, and it's our first trivia night with you. ${Count} teams tonight: ${teams}.${loved} We've time for six short rounds of four questions: plan the night, fetch each round and read it out. ${rounds} After the sixth round that's the end of tonight: leave your notes ready for next week, as you would after the last round.\n`,
    [`${night1}/task.toml`]: taskToml(
      night1,
      `A new venue's first night (${venue.pub}, ${venue.city}): the host plays six rounds to a simulated crowd and leaves its notes in memories/MEMORY.md`,
      venue,
    ),
    [`${night1}/environment/docker-compose.yaml`]: compose(venue, 1, size),
    [`${night1}/tests/test.sh`]: TEST_SH,
    [`${night1}/tests/check.mjs`]: NIGHT1_CHECK,
    [`${night1}/tests/expected.json`]: expectedFor(crowd),
    [`${night1}/solution/solve.sh`]: SOLVE_SH,
    [`${night2}/instruction.md`]: `Evening! ${night2Teams} Six short rounds of four again tonight: plan them, fetch each round and read it out. ${rounds} After the sixth round we're done, so leave your notes ready for next week.\n`,
    [`${night2}/task.toml`]: taskToml(
      night2,
      `The second night at ${venue.pub}, ${venue.city}: six rounds to a simulated crowd, most of it night 1's teams, pitched from the identity's own memory or from nothing`,
      venue,
    ),
    [`${night2}/environment/docker-compose.yaml`]: compose(venue, 2, size),
    [`${night2}/tests/test.sh`]: TEST_SH,
    [`${night2}/tests/check.mjs`]: NIGHT2_CHECK,
    [`${night2}/tests/expected.json`]: expectedFor(later, {
      night1_teams: crowd,
    }),
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
  // The tasks are generated, never committed: pass a Recipe's evals/harbor to write them there.
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
