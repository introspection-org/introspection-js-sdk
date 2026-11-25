/** The experiment's analysis: paired lifts with t-intervals, sign tests, Holm correction, the arms' ordering and the world validity gate. Pure. */

/** One pub's two night-2 scores. */
export interface Pair {
  with: number;
  without: number;
}

export type Verdict = "supported" | "not supported" | "inconclusive";

export interface Lift {
  pubs: number;
  meanWith: number;
  meanWithout: number;
  /** Mean improvement per pub: with − without, or without − with when lower is better. */
  meanDifference: number;
  /** 95% t-interval on the paired differences; null under 3 pubs. */
  interval: [number, number] | null;
  /** Pubs where memory did better. */
  higher: number;
  verdict: Verdict;
}

// Two-sided 95% t critical values by degrees of freedom.
const T95 = [
  12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201,
  2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074,
  2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];

export const MIN_PUBS = 3;

const mean = (values: number[]) =>
  values.reduce((sum, v) => sum + v, 0) / values.length;

/** Memory's lift over the pubs measured both ways; null with none. */
export function lift(
  pairs: Pair[],
  { lowerIsBetter = false }: { lowerIsBetter?: boolean } = {},
): Lift | null {
  if (!pairs.length) return null;
  const differences = pairs.map((p) =>
    lowerIsBetter ? p.without - p.with : p.with - p.without,
  );
  const meanDifference = mean(differences);
  let interval: [number, number] | null = null;
  if (pairs.length >= MIN_PUBS) {
    const n = pairs.length;
    const variance =
      differences.reduce((sum, d) => sum + (d - meanDifference) ** 2, 0) /
      (n - 1);
    const t = T95[n - 2] ?? 1.96;
    const half = t * Math.sqrt(variance / n);
    interval = [meanDifference - half, meanDifference + half];
  }
  return {
    pubs: pairs.length,
    meanWith: mean(pairs.map((p) => p.with)),
    meanWithout: mean(pairs.map((p) => p.without)),
    meanDifference,
    interval,
    higher: differences.filter((d) => d > 0).length,
    verdict: !interval
      ? "inconclusive"
      : interval[0] > 0
        ? "supported"
        : interval[1] < 0
          ? "not supported"
          : "inconclusive",
  };
}

/** A number as `+2.7`, `−0.3` or `±0.0`, to `digits` places. */
export function signed(value: number, digits = 1): string {
  const text = Math.abs(value).toFixed(digits);
  const zero = Math.abs(value) < 0.5 * 10 ** -digits;
  return zero ? `±${text}` : value > 0 ? `+${text}` : `−${text}`;
}

/** The conclusion in words; `unit` names what the interval counts, such as "points". */
export function conclusion(result: Lift, unit = "points", digits = 1): string {
  if (!result.interval)
    return `Inconclusive: ${result.pubs} pub${result.pubs === 1 ? "" : "s"} is too few for an interval; run at least ${MIN_PUBS}.`;
  const [low, high] = result.interval;
  const range = `memory improves it by between ${signed(low, digits)} and ${signed(high, digits)} ${unit} (95% interval)`;
  if (result.verdict === "supported") return `Supported: ${range}.`;
  if (result.verdict === "not supported")
    return `Not supported: ${range}, so memory did worse.`;
  return `Inconclusive: ${range}, which crosses 0.`;
}

/** One objective measure over the night 2s it applies to: "2/3", "n/a", or "waiting" before any finished. */
export function share(
  values: (number | undefined)[],
  finished: number,
): string {
  if (!finished) return "waiting";
  const told = values.filter((v): v is number => typeof v === "number");
  if (!told.length) return "n/a";
  return `${told.filter((v) => v >= 0.5).length}/${told.length}`;
}

export interface SignTest {
  /** Pubs where the first arm did better, and worse; ties are dropped. */
  positive: number;
  negative: number;
  /** Exact two-sided p-value under no difference (each untied pub a fair coin). */
  p: number;
}

const choose = (n: number, k: number) => {
  let result = 1;
  for (let i = 1; i <= k; i += 1) result = (result * (n - k + i)) / i;
  return result;
};

/** The exact two-sided sign test on paired differences. */
export function signTest(differences: number[]): SignTest {
  const positive = differences.filter((d) => d > 0).length;
  const negative = differences.filter((d) => d < 0).length;
  const n = positive + negative;
  if (!n) return { positive, negative, p: 1 };
  let tail = 0;
  for (let k = 0; k <= Math.min(positive, negative); k += 1)
    tail += choose(n, k);
  return { positive, negative, p: Math.min(1, (2 * tail) / 2 ** n) };
}

/** Holm-Bonferroni adjusted p-values, in the order given. */
export function holm(pValues: number[]): number[] {
  const m = pValues.length;
  const order = pValues
    .map((p, i) => [p, i] as const)
    .sort((a, b) => a[0] - b[0]);
  const adjusted = new Array<number>(m);
  let running = 0;
  order.forEach(([p, i], rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    adjusted[i] = running;
  });
  return adjusted;
}

/** Each arm's mean on one measure, higher better. */
export interface ArmMeans {
  perfect?: number | null;
  right: number;
  none: number;
  wrong: number;
}

export interface Ordering {
  /** Perfect notes at least as good as the right notes; true when perfect was not run. */
  perfectAtLeastRight: boolean;
  rightOverNone: boolean;
  noneOverWrong: boolean;
  /** perfect ≥ right > none > wrong. */
  holds: boolean;
}

export function ordering(means: ArmMeans): Ordering {
  const perfectAtLeastRight =
    typeof means.perfect !== "number" || means.perfect >= means.right;
  const rightOverNone = means.right > means.none;
  const noneOverWrong = means.none > means.wrong;
  return {
    perfectAtLeastRight,
    rightOverNone,
    noneOverWrong,
    holds: perfectAtLeastRight && rightOverNone && noneOverWrong,
  };
}

/** How far perfect notes must beat no notes on good rounds for the world to tell a weak host from a strong one. */
export const GATE_MIN = 0.15;

export interface Gate {
  pubs: number;
  difference: number;
  interval: [number, number] | null;
  passes: boolean;
}

/**
 * The world validity gate, on development pubs: perfect notes minus no notes
 * on good rounds is at least GATE_MIN and its 95% interval excludes 0. When it
 * fails, the world is not sensitive enough and the held-out run does not go ahead.
 */
export function validityGate(
  pairs: { perfect: number; none: number }[],
): Gate | null {
  const result = lift(pairs.map((p) => ({ with: p.perfect, without: p.none })));
  if (!result) return null;
  return {
    pubs: result.pubs,
    difference: result.meanDifference,
    interval: result.interval,
    passes:
      result.meanDifference >= GATE_MIN &&
      result.interval !== null &&
      result.interval[0] > 0,
  };
}
