/** The results summary in words, built by rules from the arms' means (no model). Pure. */

/** One arm's means over the pubs it shares with no notes. */
export interface ArmStats {
  /** Mean good rounds: a loved genre and 55-75% right. */
  good: number;
  /** Mean share of rounds in a loved genre (taste). */
  loved: number;
  /** Pubs whose first round landed 55-75% right (level). */
  firstHits: number;
}

/** An arm against no notes, at the same pubs. */
export interface Comparison {
  pubs: number;
  arm: ArmStats;
  none: ArmStats;
}

/** Below this many pubs, nothing is told apart from noise. */
export const MIN_PUBS = 3;
/** One round in a six-round night, the smallest change a share-of-rounds measure can show per pub. */
export const ONE_ROUND = 1 / 6;

const two = (x: number) => x.toFixed(2);
const pct = (x: number) => `${Math.round(x * 100)}%`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
// A difference counts when it rounds to at least one unit per pub: one round for a
// share of rounds, one pub for a count of pubs.
const real = (difference: number, unit: number) =>
  Math.round(Math.abs(difference) / unit) >= 1;

/** Model notes against no notes: whether it helped on good rounds, and whether taste or level explains it. */
export function modelWhy(c: Comparison | null): string | null {
  if (!c) return null;
  const scores = `${two(c.arm.good)} vs ${two(c.none.good)}`;
  if (c.pubs < MIN_PUBS)
    return `With ${plural(c.pubs, "pub")} this is within noise: model notes ${scores} good rounds against no notes.`;
  const good = c.arm.good - c.none.good;
  if (!real(good, ONE_ROUND))
    return `Model notes and no notes are within noise on good rounds (${scores}).`;
  const taste = c.arm.loved - c.none.loved;
  const level = c.arm.firstHits - c.none.firstHits;
  const opened = `${c.arm.firstHits} of ${plural(c.pubs, "pub")}`;
  if (good > 0) {
    const because = real(taste, ONE_ROUND)
      ? taste > 0
        ? ` because the host remembered what this crowd likes: loved genres in ${pct(c.arm.loved)} of rounds vs ${pct(c.none.loved)}.`
        : `, though it played loved genres less (${pct(c.arm.loved)} vs ${pct(c.none.loved)}).`
      : ".";
    const pitch = real(level, 1)
      ? level > 0
        ? ` It also opened at the right level at ${opened}, against ${c.none.firstHits} with no notes.`
        : ` It opened at the right level at ${opened}, fewer than with no notes.`
      : ` It opened at the right level at ${opened}, so pitch didn't help.`;
    return `Model notes beat no notes (${scores})${because}${pitch}`;
  }
  return `Model notes did worse than no notes (${scores})${
    real(taste, ONE_ROUND) && taste < 0
      ? `: it played loved genres less (${pct(c.arm.loved)} vs ${pct(c.none.loved)}).`
      : "."
  }`;
}

/** Other notes, the placebo: another pub's tastes shouldn't transfer, though a level might. */
export function otherWhy(c: Comparison | null): string | null {
  if (!c) return null;
  const scores = `${two(c.arm.good)} vs ${two(c.none.good)}`;
  if (c.pubs < MIN_PUBS)
    return `Other notes: ${plural(c.pubs, "pub")}, within noise (${scores}).`;
  const good = c.arm.good - c.none.good;
  const level =
    real(c.arm.firstHits - c.none.firstHits, 1) &&
    c.arm.firstHits > c.none.firstHits
      ? `, though their opening level carried over at ${c.arm.firstHits} of ${plural(c.pubs, "pub")}`
      : "";
  if (!real(good, ONE_ROUND))
    return `Other notes are within noise of no notes (${scores}): another pub's tastes didn't help${level}.`;
  return good < 0
    ? `Other notes did worse than no notes (${scores}): another pub's tastes don't transfer${level}.`
    : `Other notes beat no notes (${scores}), so some of what helps isn't specific to the pub${level}.`;
}

/** True notes, the ceiling: what perfect memory is worth here, and how close model notes came. */
export function trueWhy(
  c: Comparison | null,
  model?: Comparison | null,
): string | null {
  if (!c) return null;
  const scores = `${two(c.arm.good)} vs ${two(c.none.good)}`;
  if (c.pubs < MIN_PUBS)
    return `True notes, the ceiling: ${plural(c.pubs, "pub")}, within noise (${scores}).`;
  if (!real(c.arm.good - c.none.good, ONE_ROUND))
    return `True notes, the ceiling, are within noise of no notes (${scores}), so this world can't show what memory is worth.`;
  return `True notes, the ceiling: ${two(c.arm.good)} good rounds vs ${two(c.none.good)} with no notes${
    model ? `; model notes reached ${two(model.arm.good)}.` : "."
  }`;
}

export interface NextStepInput {
  pubSet: "development" | "heldout";
  /** Pubs this run played. */
  pubsRun: number;
  developmentPubs: number;
  heldoutPubs: number;
  /** Whether the model-vs-no-notes interval on good rounds includes zero, or there is none yet. */
  intervalIncludesZero: boolean;
  /** Pubs with a night 2 that failed or never ran. */
  missingNights: number;
  gatePasses: boolean | null;
  costPerTrial: number;
  trialsPerPub: number;
}

const cost = (pubs: number, input: NextStepInput) =>
  `$${(pubs * input.trialsPerPub * input.costPerTrial).toFixed(2)}`;

/** The one next step a run suggests, by simple rules. */
export function nextStep(input: NextStepInput): string {
  if (input.missingNights > 0)
    return `Rerun to fill the missing nights: ${plural(input.missingNights, "pub")} lost a night 2.`;
  if (input.pubSet === "heldout")
    return "This is the held-out result: it is used once, so report it as it stands.";
  if (input.pubsRun < input.developmentPubs || input.intervalIncludesZero)
    return `Run all ${input.developmentPubs} development pubs to get an interval (estimated cost ${cost(input.developmentPubs, input)}).`;
  if (input.gatePasses)
    return `Ready for the held-out run (${input.heldoutPubs} pubs, estimated cost ${cost(input.heldoutPubs, input)}): it is used once, for the final result.`;
  return "The world check failed, so the crowd can't tell good memory from none yet: change the world before a held-out run.";
}
