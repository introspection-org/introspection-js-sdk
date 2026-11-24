import {
  holm,
  lift,
  ordering,
  signTest,
  validityGate,
} from "../lib/experiment";

const run = process.argv[2];
const res = await fetch("http://localhost:3500/api/events");
const body = (await res.json()) as unknown;
const events = (
  Array.isArray(body) ? body : ((body as { events?: unknown[] }).events ?? [])
) as {
  type: string;
  data: Record<string, unknown>;
}[];
const fin = events.filter(
  (e) => e.type === "eval.finished" && e.data.run === run,
);
const by: Record<string, Record<string, Record<string, number>>> = {};
for (const e of fin) {
  const v = String(e.data.venue);
  (by[v] ??= {})[String(e.data.night)] = (e.data.measures ?? {}) as Record<
    string,
    number
  >;
}
const errors = fin.filter((e) => e.data.error).length;
console.log(
  `trials ${fin.length}, errors ${errors}, pubs ${Object.keys(by).length}`,
);
const arms = {
  right: "night2-hosted",
  none: "night2-fresh",
  wrong: "night2-wrong",
  perfect: "night2-perfect",
};
console.log(
  "arms seen:",
  [...new Set(fin.map((e) => String(e.data.night)))].join(", "),
);
const measures = [
  "good_rounds",
  "favourite_genre",
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
const gp = pairsOf(arms.perfect, arms.none, "good_rounds").map((p) => ({
  perfect: p.with,
  none: p.without,
}));
console.log(
  "\nWORLD GATE (perfect − none, good_rounds):",
  JSON.stringify(validityGate(gp)),
);
for (const m of ["good_rounds", "favourite_genre"]) {
  const g = pairsOf(arms.perfect, arms.none, m);
  console.log(
    `perfect vs none ${m}:`,
    JSON.stringify(lift(g)),
    "sign",
    JSON.stringify(signTest(g.map((p) => p.with - p.without))),
  );
}
const rn = pairsOf(arms.right, arms.none, "good_rounds");
console.log("right vs none good_rounds:", JSON.stringify(lift(rn)));
const ms = (a: string) => mean(pick(a, "good_rounds").map((r) => r.x));
console.log(
  "ordering:",
  JSON.stringify(
    ordering({
      perfect: ms(arms.perfect),
      right: ms(arms.right),
      none: ms(arms.none),
      wrong: ms(arms.wrong),
    }),
  ),
);
const sec = [
  "favourite_genre",
  "close_finish",
  "lead_changes",
  "bottom_share",
  "right_region",
];
const ps = sec.map(
  (m) =>
    signTest(
      pairsOf(arms.right, arms.none, m).map((p) =>
        lower.has(m) ? p.without - p.with : p.with - p.without,
      ),
    ).p,
);
console.log(
  "right vs none secondaries, Holm:",
  JSON.stringify(Object.fromEntries(sec.map((m, i) => [m, holm(ps)[i]]))),
);
console.log("\nper pub good_rounds  [none, right, perfect, wrong]:");
for (const [v, n] of Object.entries(by))
  console.log(
    v.padEnd(12),
    [arms.none, arms.right, arms.perfect, arms.wrong]
      .map((a) => n[a]?.good_rounds ?? "-")
      .join("  "),
  );
