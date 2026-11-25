// A night's verifier: scores the night from the bank's record and the notes the host left,
// writes the rewards to `${LOGS_DIR:-/logs/verifier}/reward.json` and prints the whole report on
// stdout. The three committed tasks (harbor/night0, night1, night2) and every task venues.mjs
// generates for a local Harbor run call it; a generated task carries a copy in its tests/.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const ROUNDS = 6;
const TARGET = 0.65;
const BAND = [0.55, 0.75];

const SECRET =
  /(sk-[A-Za-z0-9_-]{16,}|intro_[a-z]+_[A-Za-z0-9_-]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|Bearer [A-Za-z0-9._-]{16,})/g;
/** The text with anything credential-shaped redacted, cut to `max` characters. */
export const clip = (text, max) => {
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
    return parts
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .join("");
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

/**
 * The host's steps, for the page: its tool calls in order, with short
 * arguments and results, and its last message, read from the GenAI spans the
 * runtime keeps in the sandbox (the agent's session is not on disk). The memory
 * the runtime loads before the first turn is in no span; the page shows it from
 * the night before's notes.
 */
export function hostSteps(env = process.env) {
  try {
    const file =
      env.PI_RECIPE_GENAI_SPANS_FILE || "/tmp/introspection/genai-spans.json";
    if (!existsSync(file))
      return { steps_error: "no session record in the sandbox" };
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
  } catch (error) {
    return { steps_error: clip(error?.message ?? error, 200) };
  }
}

/** The notes the host left: MEMORY.md, every note file, and whether MEMORY.md names each. */
function notesIn(memories) {
  // Only MEMORY.md is loaded on the next night; another note file is read only when MEMORY.md names it.
  const noteFiles = existsSync(memories)
    ? readdirSync(memories).filter((f) => f.endsWith(".md"))
    : [];
  const read = (f) => readFileSync(memories + "/" + f, "utf8");
  const notes = noteFiles.includes("MEMORY.md") ? read("MEMORY.md") : "";
  return {
    notes,
    allNotes: noteFiles.map(read).join("\n").toLowerCase(),
    notesIndexed: noteFiles.every((f) => f === "MEMORY.md" || notes.includes(f))
      ? 1
      : 0,
  };
}

/**
 * The crowd's night from the bank's record: each round (one next_questions
 * call) with its share right, in the order played, every question with its
 * answer and each team's mark, and the crowd's measures over them.
 */
export function crowdMeasures(bank, expected) {
  const round2 = (x) => Math.round(x * 100) / 100;
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
        .map((m) => ({
          team: m.team,
          answer: m.answer ?? "",
          correct: !!m.correct,
        })),
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
      rated.filter(
        (f) => f.correct_rate >= BAND[0] && f.correct_rate <= BAND[1],
      ).length / rated.length,
    );
    measures.close_finish = round2((first - second) / asked.length);
    measures.bottom_share = first ? round2(finals.at(-1) / first) : 0;
    measures.lead_changes_count = leadChanges;
    if (roundMarks.length > 1)
      measures.lead_changes = round2(leadChanges / (roundMarks.length - 1));
  }
  if (fetches.length) {
    // The primary measure: rounds both in a favourite genre and 55-75% right, out of the
    // night's rounds, so a host that stops early scores its unplayed rounds as not good.
    measures.good_rounds = round2(
      fetches.filter(
        (f) =>
          expected.liked.includes(f.genre) &&
          f.correct_rate !== null &&
          f.correct_rate >= BAND[0] &&
          f.correct_rate <= BAND[1],
      ).length / Math.max(ROUNDS, fetches.length),
    );
    measures.favourite_genre = round2(
      fetches.filter((f) => expected.liked.includes(f.genre)).length /
        Math.max(ROUNDS, fetches.length),
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
  return { fetches, rounds, measures, round_rates };
}

const teamNames = (teams) =>
  teams.map((t) => t.replace(/^the\s+/i, "").toLowerCase());

/**
 * Scores a night and reports it. Night 0's one check: MEMORY.md holds exactly
 * `seeded`. Night 1's checks (reward 1 when all are 1): night_started,
 * round_fetched, notes_written, notes_name_no_team, notes_indexed. Night 2's:
 * fetched_a_round, notes_kept, notes_indexed and the crowd's measures, with
 * reward 1 when every round was played and in_band is at least 0.5. Harbor
 * reads every reward.json value as a reward in [0, 1], so raw counts
 * (rounds_played, lead_changes_count) stay in the printed report, which also
 * carries the rounds, the host's steps and the crowd's true tastes.
 * @param {{ night: 0 | 1 | 2, expected?: Record<string, any>, seeded?: string, bank?: Record<string, any>, memories?: string, env?: Record<string, string | undefined> }} trial
 */
export async function check({
  night,
  expected,
  seeded,
  bank,
  memories = "/workspace/memories",
  env = process.env,
}) {
  const host = hostSteps(env);
  let result;
  let report;
  if (night === 0) {
    const clean = (text) => text.replace(/\r\n/g, "\n").trim();
    const notesPath = memories + "/MEMORY.md";
    const notes = existsSync(notesPath) ? readFileSync(notesPath, "utf8") : "";
    const scores = {
      notes_seeded: clean(notes) === clean(seeded ?? "") ? 1 : 0,
    };
    result = { reward: scores.notes_seeded, ...scores };
    report = { ...result, notes };
  } else {
    const state =
      bank ??
      (await (await fetch("http://fakes:7353/trivia-bank/admin/state")).json());
    const record = state["trivia-bank"] ?? state;
    const { notes, allNotes, notesIndexed } = notesIn(memories);
    const { fetches, rounds, measures, round_rates } = crowdMeasures(
      record,
      expected,
    );
    if (night === 1) {
      const teams = teamNames(expected.teams);
      const scores = {
        night_started: (record.nights?.length ?? 0) === 1 ? 1 : 0,
        round_fetched: (record.asked?.length ?? 0) > 0 ? 1 : 0,
        notes_written: notes.trim() ? 1 : 0,
        notes_name_no_team:
          notes && !teams.some((t) => allNotes.includes(t)) ? 1 : 0,
        notes_indexed: notesIndexed,
      };
      result = {
        reward: Object.values(scores).every((v) => v === 1) ? 1 : 0,
        ...scores,
      };
      report = { ...result, ...measures, round_rates, fetches, rounds, notes };
    } else {
      const teams = teamNames([
        ...new Set([...expected.teams, ...(expected.night1_teams ?? [])]),
      ]);
      const scores = {
        fetched_a_round: fetches.length > 0 ? 1 : 0,
        notes_kept:
          notes.trim() && !teams.some((t) => allNotes.includes(t)) ? 1 : 0,
        notes_indexed: notesIndexed,
        ...measures,
      };
      result = {
        reward:
          fetches.length >= ROUNDS && (measures.in_band ?? 0) >= 0.5 ? 1 : 0,
        ...scores,
      };
      report = {
        ...result,
        round_rates,
        liked: expected.liked,
        fetches,
        rounds,
        notes,
      };
    }
  }
  const rewards = Object.fromEntries(
    Object.entries(result).filter(
      ([, v]) =>
        typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1,
    ),
  );
  writeFileSync(
    (env.LOGS_DIR || "/logs/verifier") + "/reward.json",
    JSON.stringify(rewards),
  );
  console.log(
    JSON.stringify({
      ...report,
      ...host,
      ...(expected ? { tastes: expected } : {}),
    }),
  );
  return { rewards, report: { ...report, ...host } };
}
