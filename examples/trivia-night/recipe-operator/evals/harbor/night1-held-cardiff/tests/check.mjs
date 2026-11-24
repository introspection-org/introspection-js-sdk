// Night 1's checks (reward 1 when all are 1): night_started, round_fetched,
// notes_written, notes_name_no_team (in any note file), notes_indexed (every note file named in MEMORY.md). The crowd's measures are printed too,
// as on night 2, for comparison: good_rounds, pitch_miss, in_band,
// close_finish, lead_changes, bottom_share, favourite_genre, right_region,
// and round_rates (each round's share right, in the order played).
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

const expected = JSON.parse(
  readFileSync(new URL("./expected.json", import.meta.url), "utf8"),
);
const state = await (
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
const rated = fetches.filter((f) => f.correct_rate !== null);
const round2 = (x) => Math.round(x * 100) / 100;
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
  // The primary measure: rounds both in a favourite genre and 55-75% right.
  measures.good_rounds = round2(
    fetches.filter(
      (f) =>
        expected.liked.includes(f.genre) &&
        f.correct_rate !== null &&
        f.correct_rate >= BAND[0] &&
        f.correct_rate <= BAND[1],
    ).length / fetches.length,
  );
  measures.favourite_genre = round2(
    fetches.filter((f) => expected.liked.includes(f.genre)).length /
      fetches.length,
  );
  measures.right_region = asked.every((a) =>
    [expected.region, "global"].includes(a.region),
  )
    ? 1
    : 0;
}
const round_rates = fetches.map((f) =>
  f.correct_rate === null ? null : round2(f.correct_rate),
);

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
writeFileSync(
  "/logs/verifier/reward.json",
  JSON.stringify({ reward, ...scores }),
);
console.log(
  JSON.stringify(
    { reward, ...scores, ...measures, round_rates, fetches, notes },
    null,
    2,
  ),
);
