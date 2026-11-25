import {
  holm,
  lift,
  ordering,
  signTest,
  validityGate,
} from "../lib/experiment";
import { cliSession } from "../lib/cli-session";
import { runResults } from "../lib/platform-runner";

const run = process.argv[2];
if (!run) throw new Error("usage: analyze.mts <run-id>");
// The run is its tasks on the platform, read as the member `introspection login` signed in.
const results = await runResults(cliSession().client, run);
if (!results) throw new Error(`no trials found for run ${run}`);
// A trial that errored measured nothing: it is counted and reported, never analysed.
const fin = results.filter((e) => !e.error);
const by: Record<string, Record<string, Record<string, number>>> = {};
// Runs before the verifier printed first_round_in_band: the first round's share right says the same.
const BAND = [0.55, 0.75];
// A true-notes night 2 counts only when its night 0 seeded the true notes (the pre-registration's rule).
const seeded = new Set(
  fin
    .filter((e) => e.night === "night0-seed" && e.checks.notes_seeded === 1)
    .map((e) => e.venue),
);
for (const e of fin) {
  const v = e.venue;
  if (e.night === "night2-perfect" && !seeded.has(v)) continue;
  const measures: Record<string, number> = { ...e.measures };
  const opening = e.fetches?.[0]?.correct_rate;
  if (
    typeof measures.first_round_in_band !== "number" &&
    typeof opening === "number"
  )
    measures.first_round_in_band =
      opening >= BAND[0] && opening <= BAND[1] ? 1 : 0;
  (by[v] ??= {})[e.night] = measures;
}
const errors = results.length - fin.length;
console.log(
  `trials ${fin.length}, errors ${errors}, pubs ${Object.keys(by).length}`,
);
// Night 2's arms by their display names: model, no, other and true notes.
const arms = {
  model: "night2-hosted",
  none: "night2-fresh",
  other: "night2-wrong",
  true: "night2-perfect",
};
console.log("arms seen:", [...new Set(fin.map((e) => e.night))].join(", "));
const measures = [
  "good_rounds",
  "favourite_genre",
  "first_round_in_band",
  "close_finish",
  "lead_changes",
  "bottom_share",
  "right_region",
  "notes_accuracy",
  "pitch_miss",
  "in_band",
];
const lower = new Set(["bottom_share", "pitch_miss"]);
const pick = (arm: string, m: string) =>
  Object.entries(by)
    .map(([v, n]) => ({ v, x: n[arm]?.[m] }))
    .filter((r): r is { v: string; x: number } => typeof r.x === "number");
const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
for (const m of measures) {
  const row = Object.fromEntries(
    Object.entries(arms).map(([k, a]) => [
      k,
      mean(pick(a, m).map((r) => r.x)).toFixed(3),
    ]),
  );
  console.log(m.padEnd(16), JSON.stringify(row));
}
const pairsOf = (a: string, b: string, m: string) =>
  Object.values(by)
    .filter(
      (n) => typeof n[a]?.[m] === "number" && typeof n[b]?.[m] === "number",
    )
    .map((n) => ({ with: n[a][m], without: n[b][m] }));
const gp = pairsOf(arms.true, arms.none, "good_rounds").map((p) => ({
  perfect: p.with,
  none: p.without,
}));
console.log(
  "\nWORLD GATE (true − no notes, good_rounds):",
  JSON.stringify(validityGate(gp)),
);
for (const m of ["good_rounds", "favourite_genre"]) {
  const g = pairsOf(arms.true, arms.none, m);
  console.log(
    `true vs no notes ${m}:`,
    JSON.stringify(lift(g)),
    "sign",
    JSON.stringify(signTest(g.map((p) => p.with - p.without))),
  );
}
const rn = pairsOf(arms.model, arms.none, "good_rounds");
console.log(
  "PRIMARY model vs no notes, good_rounds:",
  JSON.stringify(lift(rn)),
);
const ro = pairsOf(arms.model, arms.other, "good_rounds");
console.log(
  "model vs other notes, good_rounds sign test:",
  JSON.stringify(signTest(ro.map((p) => p.with - p.without))),
);
const ms = (a: string) => mean(pick(a, "good_rounds").map((r) => r.x));
console.log(
  "ordering:",
  JSON.stringify(
    ordering({
      perfect: ms(arms.true),
      right: ms(arms.model),
      none: ms(arms.none),
      wrong: ms(arms.other),
    }),
  ),
);
// The two secondaries that explain good rounds: taste and level. The rest are descriptive.
const sec = ["favourite_genre", "first_round_in_band"];
const ps = sec.map(
  (m) =>
    signTest(
      pairsOf(arms.model, arms.none, m).map((p) =>
        lower.has(m) ? p.without - p.with : p.with - p.without,
      ),
    ).p,
);
console.log(
  "model vs no notes secondaries, Holm:",
  JSON.stringify(Object.fromEntries(sec.map((m, i) => [m, holm(ps)[i]]))),
);
console.log(
  "descriptive only: close_finish, lead_changes, bottom_share, right_region, in_band (means above)",
);
console.log("\nper pub good_rounds  [no, model, true, other]:");
for (const [v, n] of Object.entries(by))
  console.log(
    v.padEnd(12),
    [arms.none, arms.model, arms.true, arms.other]
      .map((a) => n[a]?.good_rounds ?? "-")
      .join("  "),
  );
