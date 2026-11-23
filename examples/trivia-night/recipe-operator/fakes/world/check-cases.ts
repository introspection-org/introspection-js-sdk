// node world/check-cases.ts <C1|C2|C3> <series-dir>
// The code checks each approved case's Verification names, read from the series' recorded calls and
// the venue's memory after each night. Prints each check and PASS/FAIL; exits 1 on any failure.
import fs from "node:fs";
import path from "node:path";
import { question } from "../mcp/trivia-bank/supply.ts";
import { byId } from "./profiles.ts";
import { carriesRequest, forbidden } from "./score.ts";

const [caseId, dir] = process.argv.slice(2);
type Call = { server: string; tool: string; args: any; result: any };
const text = (c: Call) => c.result?.content?.[0]?.text ?? "";
const nightCalls = (n: number): Call[] =>
  fs
    .readFileSync(path.join(dir, `trajectory-${n}.jsonl`), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
const notes = (n: number) => {
  const d = path.join(dir, `memory-after-${n}`);
  return fs
    .readdirSync(d)
    .map((f) => fs.readFileSync(path.join(d, f), "utf8"))
    .join("\n");
};
const nights = fs
  .readdirSync(dir)
  .filter((f) => /^trajectory-\d+\.jsonl$/.test(f)).length;
let failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`,
  );
};

// One night's rounds: each next_questions call, the questions it returned, and the submit that followed it.
function roundsOf(calls: Call[]) {
  const out: { args: any; qs: any[]; relaxed: string | null; submit?: Call }[] =
    [];
  for (const c of calls) {
    if (c.server !== "trivia-bank") continue;
    if (c.tool === "next_questions" && !c.result?.isError) {
      const v = JSON.parse(text(c));
      out.push({ args: c.args, qs: v.questions, relaxed: v.relaxed });
    }
    if (c.tool === "submit_round" && !c.result?.isError && out.length)
      out[out.length - 1].submit ??= c;
  }
  return out;
}
const rate = (s?: Call) => {
  if (!s) return null;
  const m = JSON.parse(text(s)).marks as { correct: boolean }[];
  return m.filter((x) => x.correct).length / m.length;
};

function roundRules(n: number, regions: string[], teams: string[]) {
  const calls = nightCalls(n).filter((c) => c.server === "trivia-bank");
  const first = (t: string) => calls.findIndex((c) => c.tool === t);
  check(
    `night ${n}: start_night once, before the first next_questions`,
    calls.filter((c) => c.tool === "start_night").length === 1 &&
      first("start_night") < first("next_questions"),
  );
  const rs = roundsOf(nightCalls(n));
  check(
    `night ${n}: every round fetched with one genre and one difficulty`,
    rs.every(
      (r) =>
        r.args.genre &&
        r.args.difficulty &&
        !r.relaxed &&
        new Set(r.qs.map((q) => `${q.genre}/${q.difficulty}`)).size === 1,
    ),
    rs
      .map((r) => `${r.args.genre}/${r.args.difficulty}/${r.args.region}`)
      .join(", "),
  );
  check(
    `night ${n}: every question from region ${regions.join(" or ")}`,
    rs.every((r) => r.qs.every((q) => regions.includes(q.region))),
  );
  const subs = calls.filter(
    (c) => c.tool === "submit_round" && !c.result?.isError,
  );
  check(
    `night ${n}: one submit_round per round`,
    subs.length === rs.length,
    `${subs.length} submits, ${rs.length} rounds`,
  );
  check(
    `night ${n}: each submit covers every team and every question of its round`,
    rs.every((r) => {
      if (!r.submit) return false;
      const got = new Set(
        r.submit.args.answers.map((a: any) => `${a.team}|${a.question_id}`),
      );
      return (
        got.size === teams.length * r.qs.length &&
        teams.every((t) => r.qs.every((q) => got.has(`${t}|${q.id}`)))
      );
    }),
  );
  const diffs = rs.map((r) => r.args.difficulty);
  check(
    `night ${n}: difficulty never moves more than one level between rounds`,
    diffs.every((d, i) => i === 0 || Math.abs(d - diffs[i - 1]) <= 1),
    diffs.join("→"),
  );
  return rs;
}

// At most one difficulty line per genre in the notes (the adopted memory block's rule).
function oneLevelLinePerGenre(n: number) {
  const lines = notes(n)
    .split("\n")
    .filter((l) => /\b(level|difficulty)\s*\d/i.test(l));
  const per = new Map<string, number>();
  for (const l of lines)
    for (const g of [
      "music",
      "film",
      "sport",
      "science",
      "history",
      "geography",
    ])
      if (new RegExp(`\\b${g}\\b`, "i").test(l))
        per.set(g, (per.get(g) ?? 0) + 1);
  const extra = [...per].filter(([, k]) => k > 1);
  // Informational only: this was the withdrawn beliefs block's rule, not a case requirement.
  console.log(
    `INFO  notes after night ${n}: difficulty lines per genre ${extra.length ? extra.map(([g, k]) => `${g}×${k}`).join(", ") : "at most one each"}`,
  );
}

const p = byId(`case-${caseId.toLowerCase()}`)!;
if (caseId === "C1") {
  const rs = roundRules(1, ["au", "global"], p.teams);
  const reg = nightCalls(1).find((c) => c.tool === "register_teams");
  check(
    "night 1: the four teams registered",
    !!reg &&
      [...reg.args.names].sort().join("|") === [...p.teams].sort().join("|"),
  );
  const r1 = rate(rs[0]?.submit);
  check(
    "round 1 landed above 75% (the case's situation)",
    r1 !== null && r1 > 0.75,
    `round 1 ${r1 === null ? "-" : (r1 * 100).toFixed(0)}%`,
  );
  oneLevelLinePerGenre(1);
  check(
    "round 2 is exactly one level above round 1",
    rs.length >= 2 && rs[1].args.difficulty === rs[0].args.difficulty + 1,
    `${rs[0]?.args.difficulty}→${rs[1]?.args.difficulty}`,
  );
} else if (caseId === "C2") {
  check("two nights played", nights === 2, `${nights}`);
  for (const n of [1, 2]) roundRules(n, ["uk", "global"], p.teams);
  const a = roundsOf(nightCalls(1)),
    b = roundsOf(nightCalls(2));
  check(
    "birthday night: every round is music",
    a.length > 0 && a.every((r) => r.args.genre === "music"),
    a.map((r) => r.args.genre).join(", "),
  );
  const bg = b.map((r) => r.args.genre);
  check(
    "next week: not all music",
    bg.some((g) => g !== "music"),
    bg.join(", "),
  );
  check(
    "next week: mostly sport or history",
    bg.filter((g) => g === "sport" || g === "history").length * 2 > bg.length,
    bg.join(", "),
  );
  for (const n of [1, 2]) {
    const ids = [...nightCalls(1), ...nightCalls(2)]
      .filter((c) => c.tool === "next_questions" && !c.result?.isError)
      .flatMap((c) => JSON.parse(text(c)).questions.map((q: any) => q.id));
    const f = forbidden(notes(n), p, ids);
    check(
      `notes after night ${n}: no team names, scores, standings or questions`,
      f.length === 0,
      f.join("; "),
    );
    check(
      `notes after night ${n}: the music request is not kept as a liking, and Dave isn't named`,
      !carriesRequest(notes(n), p),
    );
    check(
      `notes after night ${n}: still name sport and history`,
      /sport/i.test(notes(n)) && /history/i.test(notes(n)),
    );
    oneLevelLinePerGenre(n);
  }
} else if (caseId === "C3") {
  check("three nights played", nights === 3, `${nights}`);
  for (let n = 1; n <= nights; n++) {
    roundRules(n, ["uk", "global"], p.teams);
    const f = forbidden(notes(n), p, []);
    check(
      `notes after night ${n}: no team names, scores, standings or questions`,
      f.length === 0,
      f.join("; "),
    );
    oneLevelLinePerGenre(n);
  }
}
console.log(failed ? `${failed} check(s) failed` : "all code checks passed");
process.exit(failed ? 1 : 0);
