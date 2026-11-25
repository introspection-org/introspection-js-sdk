/**
 * How well a night suited its crowd, per trial: pure, from the verifier's
 * checks (computed from the bank's record of the simulated crowd's answers),
 * its rounds, the venue's tastes (its trial's truth, from evals/venues.json) and its notes.
 */

/** One round (one `next_questions` call), as the verifier prints it. */
export interface Fetch {
  genre?: string;
  difficulty?: number;
  region?: string;
  count?: number;
  /** Share of the crowd's answers that were right; null when nothing was marked. */
  correct_rate?: number | null;
}

/** A venue's task facts: its country and the crowd's tastes and level. */
export interface VenueTastes {
  region: string;
  liked?: string[];
  disliked?: string[];
  /** The favourite night 1's instruction named; the rest are for the host to find. */
  hinted?: string[];
  /** The decades night 1's crowd knows best, best first. */
  best_decades?: string[];
  target_difficulty?: number;
}

export type MeasureKey =
  | "notes_written"
  | "notes_accuracy"
  | "notes_kept"
  | "good_rounds"
  | "pitch_miss"
  | "in_band"
  | "close_finish"
  | "lead_changes"
  | "bottom_share"
  | "favourite_genre"
  | "first_round_in_band"
  | "right_region";

/** Each a number from 0 to 1; absent when it can't be told (no round fetched, say). */
export type Measures = Partial<Record<MeasureKey, number>>;

export interface MeasureInput {
  checks: Record<string, number>;
  notes?: string | null;
  fetches?: Fetch[];
  tastes?: VenueTastes | null;
  /** The notes this venue's night 1 left, for night 2; null when it had none. */
  night1Notes?: string | null;
}

/** The share right a round aims at, and the band counted as well pitched. */
export const TARGET = 0.65;
export const BAND: [number, number] = [0.55, 0.75];

/** Each measure in plain words, and which way is better. */
export const MEASURES: Record<
  MeasureKey,
  { label: string; why: string; better: "higher" | "lower" }
> = {
  good_rounds: {
    label: "good rounds",
    why: "Share of rounds both in a genre the crowd loves and 55-75% right (the primary measure)",
    better: "higher",
  },
  notes_written: {
    label: "notes written",
    why: "Night 1 left notes on the pub for next week",
    better: "higher",
  },
  notes_accuracy: {
    label: "notes matched the crowd",
    why: "Night 1's notes against the crowd's true tastes: the favourite it was not told about named as liked, no disliked genre named as liked, the right country, and a starting difficulty within one of the crowd's level",
    better: "higher",
  },
  notes_kept: {
    label: "notes kept",
    why: "Night 2 left notes for next week, naming no team",
    better: "higher",
  },
  pitch_miss: {
    label: "pitch miss",
    why: "Mean distance of each round's share right from 65%",
    better: "lower",
  },
  in_band: {
    label: "rounds in band",
    why: "Share of rounds the crowd got 55-75% right",
    better: "higher",
  },
  close_finish: {
    label: "finish gap",
    why: "Gap between the top two teams, as a share of the points on offer",
    better: "lower",
  },
  lead_changes: {
    label: "lead changes",
    why: "Times the lead changed hands after a round, as a share of the rounds after the first",
    better: "higher",
  },
  bottom_share: {
    label: "last place's share",
    why: "The last-placed team's points as a share of the winner's",
    better: "higher",
  },
  favourite_genre: {
    label: "favourite genres",
    why: "Share of rounds in a genre the crowd loves",
    better: "higher",
  },
  first_round_in_band: {
    label: "first round pitched right",
    why: "Night 2's first round landed 55-75% right, before any of the night's marks could guide it",
    better: "higher",
  },
  right_region: {
    label: "right region",
    why: "Every question from the pub's country, or global",
    better: "higher",
  },
};

const round2 = (x: number) => Math.round(x * 100) / 100;
const num = (v: unknown): v is number => typeof v === "number";

/** The crowd's measures: the verifier's where it printed them, else derived from the rounds. */
export function crowdMeasures({
  checks,
  fetches = [],
  tastes,
}: MeasureInput): Measures {
  const measures: Measures = {};
  const rated = fetches
    .map((f) => f.correct_rate)
    .filter((r): r is number => num(r));
  const derived: Measures = {};
  if (rated.length) {
    derived.pitch_miss = round2(
      rated.reduce((s, r) => s + Math.abs(r - TARGET), 0) / rated.length,
    );
    derived.in_band = round2(
      rated.filter((r) => r >= BAND[0] && r <= BAND[1]).length / rated.length,
    );
  }
  const opening = fetches[0]?.correct_rate;
  if (num(opening))
    derived.first_round_in_band =
      opening >= BAND[0] && opening <= BAND[1] ? 1 : 0;
  if (fetches.length && tastes) {
    const liked = tastes.liked ?? [];
    derived.good_rounds = round2(
      fetches.filter(
        (f) =>
          f.genre &&
          liked.includes(f.genre) &&
          num(f.correct_rate) &&
          f.correct_rate >= BAND[0] &&
          f.correct_rate <= BAND[1],
      ).length / fetches.length,
    );
    derived.favourite_genre = round2(
      fetches.filter((f) => f.genre && liked.includes(f.genre)).length /
        fetches.length,
    );
    derived.right_region = fetches.every((f) =>
      (f.region ?? "")
        .split("+")
        .every((r) => [tastes.region, "global"].includes(r)),
    )
      ? 1
      : 0;
  }
  for (const key of [
    "good_rounds",
    "pitch_miss",
    "in_band",
    "close_finish",
    "lead_changes",
    "bottom_share",
    "favourite_genre",
    "first_round_in_band",
    "right_region",
  ] as const) {
    const value = num(checks[key]) ? checks[key] : derived[key];
    if (num(value)) measures[key] = value;
  }
  return measures;
}

const GENRES = ["music", "film", "sport", "science", "history", "geography"];
// A country by name (any case), or by code in capitals, in backticks or after "region".
const COUNTRIES: Record<string, RegExp[]> = {
  au: [/\b(?:australia|aussie)\b|`au`|\bregion:? au\b/i, /\bAU\b/],
  uk: [
    /\b(?:united kingdom|britain|british|england|scotland|wales)\b|`uk`|\bregion:? uk\b/i,
    /\bUK\b/,
  ],
  us: [/\b(?:united states|america|usa)\b|`us`|\bregion:? us\b/i, /\bUS\b/],
};
const LIKING =
  /\b(?:likes?|liked|loves?|loved|enjoys?|enjoyed|favou?rites?|favou?red|popular|keen on|fans? of|went down well)\b/i;
const NEGATION =
  /\b(?:not|no|never|dislikes?|disliked|hates?|avoid|bored)\b|n't\b/i;

/** The genres a venue's notes say the crowd likes: those in a clause that says so and isn't negated. */
export function likedInNotes(notes: string): string[] {
  const text = notes.replace(/\([^)]*\)/g, " ");
  const liked = new Set<string>();
  for (const clause of text.split(
    /[.;\n]|,\s*(?:and|so|then)\s|\b(?:but|while|whereas)\b/i,
  )) {
    if (!LIKING.test(clause) || NEGATION.test(clause)) continue;
    for (const genre of GENRES)
      if (new RegExp(`\\b${genre}s?\\b`, "i").test(clause)) liked.add(genre);
  }
  return [...liked];
}

/** The difficulty a venue's notes say to start next night at, or null when they name none. */
export function startingLevel(notes: string): number | null {
  const start =
    /\bstart\w*\b[^.\n]*?\b(?:at|on|with|from)\s+(?:difficulty\s+|level\s+|diff\s+)?(\d)/i.exec(
      notes,
    ) ?? /\b(?:starting )?difficulty:?\s*(\d)\b/i.exec(notes);
  return start ? Number(start[1]) : null;
}

/** Whether the notes name a decade (reported beside notes accuracy, not scored) ("1980s", "80s", "'80s"; "noughties" for the 2000s) outside a negated clause. */
export function namesDecade(notes: string, decade: string): boolean {
  const year = Number.parseInt(decade, 10);
  if (!Number.isFinite(year)) return false;
  const short = String(year % 100).padStart(2, "0");
  const pattern = new RegExp(
    `(?:\\b${year}'?s\\b|(?:^|[^\\d])'?${short}'?s\\b${year === 2000 ? "|\\bnoughties\\b" : ""})`,
    "i",
  );
  return notes
    .split(/[.;\n]|\b(?:but|while|whereas)\b/i)
    .some((clause) => pattern.test(clause) && !NEGATION.test(clause));
}

/**
 * How well night 1's notes match the crowd, 0 to 1, with no model: the mean
 * of the share of un-hinted favourites named as liked (all favourites when
 * none was hinted), no disliked genre named as liked, the right country and
 * no other, and a starting difficulty within one of the crowd's level.
 */
export function notesAccuracy(notes: string, tastes: VenueTastes): number {
  const named = likedInNotes(notes);
  const hinted = tastes.hinted ?? [];
  const learn = (tastes.liked ?? []).filter((g) => !hinted.includes(g));
  const favourites = learn.length ? learn : (tastes.liked ?? []);
  const found = favourites.length
    ? favourites.filter((g) => named.includes(g)).length / favourites.length
    : 1;
  const clean = (tastes.disliked ?? []).some((g) => named.includes(g)) ? 0 : 1;
  const countries = Object.keys(COUNTRIES).filter((c) =>
    COUNTRIES[c].some((pattern) => pattern.test(notes)),
  );
  const country =
    countries.length === 1 && countries[0] === tastes.region ? 1 : 0;
  const level = startingLevel(notes);
  const pitch =
    level !== null &&
    typeof tastes.target_difficulty === "number" &&
    Math.abs(level - tastes.target_difficulty) <= 1
      ? 1
      : 0;
  return round2((found + clean + country + pitch) / 4);
}

export function night1Measures(input: MeasureInput): Measures {
  const { checks, notes, tastes } = input;
  return {
    notes_written: checks.notes_written ?? (notes?.trim() ? 1 : 0),
    ...(notes?.trim() && tastes
      ? { notes_accuracy: notesAccuracy(notes, tastes) }
      : {}),
    ...crowdMeasures(input),
  };
}

export function night2Measures(input: MeasureInput): Measures {
  const measures = crowdMeasures(input);
  // Only a night 2 that had night 1's notes kept them.
  if (input.night1Notes && num(input.checks.notes_kept))
    measures.notes_kept = input.checks.notes_kept;
  return measures;
}

export function measuresOf(night: string, input: MeasureInput): Measures {
  return night === "night1-memory" || night === "night1-donor"
    ? night1Measures(input)
    : night2Measures(input);
}

/** The verifier's yes/no checks, in plain words; every other key is a measure. */
const YES_NO: Record<string, string> = {
  night_started: "Night started",
  round_fetched: "Round fetched",
  fetched_a_round: "Quiz run",
  notes_written: "Notes written",
  notes_name_no_team: "Notes name no team",
  notes_kept: "Notes kept for next week",
  notes_indexed: "Every note file named in MEMORY.md",
  notes_seeded: "True notes seeded",
  right_region: "Questions from the right region",
};

/** One verifier row: a yes/no check carries `pass`; a measure reads as its value. */
export interface CheckLine {
  key: string;
  text: string;
  pass?: boolean;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** A verifier key and value in plain words, using the night's rounds where they say more. */
export function checkLine(
  key: string,
  value: number,
  fetches: Fetch[] = [],
): CheckLine {
  if (key in YES_NO) return { key, text: YES_NO[key], pass: value === 1 };
  const rated = fetches
    .map((f) => f.correct_rate)
    .filter((r): r is number => num(r));
  if (key === "in_band") {
    const text = rated.length
      ? `${rated.filter((r) => r >= BAND[0] && r <= BAND[1]).length} of ${rated.length} (${rated.map(pct).join(", ")} right)`
      : pct(value);
    return { key, text: `Rounds pitched right: ${text}` };
  }
  if (key === "good_rounds")
    return {
      key,
      text: `Good rounds (favourite genre, pitched right): ${
        fetches.length
          ? `${Math.round(value * fetches.length)} of ${fetches.length}`
          : pct(value)
      }`,
    };
  if (key === "favourite_genre")
    return {
      key,
      text: `Rounds in favourite genres: ${
        fetches.length
          ? `${Math.round(value * fetches.length)} of ${fetches.length}`
          : pct(value)
      }`,
    };
  if (key === "close_finish") {
    const asked = fetches.reduce((s, f) => s + (f.count ?? 0), 0);
    const gap = Math.round(value * asked);
    return {
      key,
      text: `How close the finish was: ${
        asked
          ? `within ${gap} point${gap === 1 ? "" : "s"}`
          : `${pct(value)} gap`
      }`,
    };
  }
  if (key === "pitch_miss")
    return {
      key,
      text: `Average miss from ${pct(TARGET)} right: ${Math.round(value * 100)} points`,
    };
  const label = MEASURES[key as MeasureKey]?.label ?? key.replace(/_/g, " ");
  return {
    key,
    text: `${label[0].toUpperCase()}${label.slice(1)}: ${value}`,
  };
}
