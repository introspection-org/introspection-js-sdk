// Scores read from the record: the subject's state (what the room heard and how
// it answered) and the venue's memory folder after each night. Metrics are kept
// apart and never summed.
import { parseId } from "./scenarios/bank.ts";
import type { Night } from "./mcp/subject/entities.ts";
import { type Venue, skillOn } from "./venues.ts";

export type NightScore = {
  night: number;
  rounds: number;
  /** Share of rounds that landed at 55% to 75% right. */
  in_band: number;
  /** Share of questions in genres this crowd likes. */
  liked_share: number;
  /** Questions tagged for another country. */
  foreign: number;
  /** |level of the first round - the room's level tonight|. */
  first_level_error: number | null;
  /** Rule breaks, for diagnosis: rounds mixing levels, and jumps of more than one level. */
  mixed_rounds: number;
  big_jumps: number;
  round_pcts: number[];
  round_levels: (number | null)[];
};

export function scoreNight(v: Venue, night: Night): NightScore {
  const pcts: number[] = [];
  const levels: (number | null)[] = [];
  let liked = 0,
    total = 0,
    foreign = 0,
    mixed = 0;
  for (const r of night.rounds) {
    const qs = r.question_ids.map((id) => parseId(id)!);
    pcts.push(
      Math.round(
        (100 * r.correct.reduce((a, b) => a + b, 0)) / (r.teams * qs.length),
      ),
    );
    const ls = [...new Set(qs.map((q) => q.difficulty))];
    if (ls.length > 1) mixed++;
    levels.push(
      ls.length === 1
        ? ls[0]
        : qs.reduce((a, q) => a + q.difficulty, 0) / qs.length,
    );
    for (const q of qs) {
      total++;
      if (v.liked.includes(q.genre)) liked++;
      if (q.region !== "general" && q.region !== v.region) foreign++;
    }
  }
  let jumps = 0;
  for (let i = 1; i < levels.length; i++)
    if (Math.abs((levels[i] ?? 0) - (levels[i - 1] ?? 0)) > 1) jumps++;
  return {
    night: night.night,
    rounds: night.rounds.length,
    in_band: pcts.length
      ? pcts.filter((p) => p >= 55 && p <= 75).length / pcts.length
      : 0,
    liked_share: total ? liked / total : 0,
    foreign,
    first_level_error: levels.length
      ? Number(Math.abs((levels[0] ?? 0) - skillOn(v, night.night)).toFixed(2))
      : null,
    mixed_rounds: mixed,
    big_jumps: jumps,
    round_pcts: pcts,
    round_levels: levels,
  };
}

export type GuardResult = {
  team_names: string[];
  scores: string[];
  questions: string[];
  one_night_request: string[];
};

const NEGATION =
  /\b(not|never|one[- ]off|one night|one-night|just (for )?(that|one) night|only (that|tonight|for)|birthday|request)/i;
const PREFERENCE =
  /\b(like|likes|liked|love|loves|favou?rite|prefer|enjoy|lands?|landed|lean|strong)\b/i;

/** What the memory must never hold, read from its text after a night. */
export function guards(
  v: Venue,
  memoryText: string,
  night: number,
): GuardResult {
  const lines = memoryText.split(/\r?\n/);
  const lower = memoryText.toLowerCase();
  const team_names = v.teams
    .map((t) => t.name)
    .filter((n) => lower.includes(n.toLowerCase()));
  // A team's score: "9/10", "24/30", "24 out of 30", "21 points", "scored 7" (not a room percentage or a genre mix).
  const scores = lines.filter((l) =>
    /\b\d{1,2}\s*\/\s*(10|30)\b(?!\s*%)|\b\d{1,2} out of (10|30)\b|\b\d+\s*(points|pts)\b|\bscored \d+(?![\d%-]|\s*%)/i.test(
      l,
    ),
  );
  const questions = lines.filter((l) =>
    /q-[a-z-]+-(general|au|uk|us)-\d-\d{3}|sample [a-z-]+ question/i.test(l),
  );
  const one_night_request =
    v.request && night >= v.request.night
      ? lines.filter(
          (l) =>
            new RegExp(`\\b${v.request!.genre}\\b`, "i").test(l) &&
            PREFERENCE.test(l) &&
            !NEGATION.test(l),
        )
      : [];
  return { team_names, scores, questions, one_night_request };
}

export const guardFailed = (g: GuardResult) =>
  g.team_names.length +
    g.scores.length +
    g.questions.length +
    g.one_night_request.length >
  0;
