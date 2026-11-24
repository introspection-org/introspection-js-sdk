/**
 * What memory changed, per trial and over a run: pure, from a trial's checks,
 * its round fetches, the venue's tastes (its task's expected.json) and the
 * notes night 1 left.
 */
import { startingDifficulty } from "./display";

/** One `next_questions` call, as the night-2 verifier prints it. */
export interface Fetch {
  genre?: string;
  difficulty?: number;
  region?: string;
  count?: number;
}

/** A venue's task facts: its country and, when the profile says, its tastes. */
export interface VenueTastes {
  region: string;
  likes?: string[];
  start_difficulty?: number;
}

export type MeasureKey =
  | "notes_written"
  | "recalled"
  | "right_region"
  | "liked_genres"
  | "difficulty_from_notes";

/** 1 or 0 for a yes/no measure, a share (0-1) for liked_genres; absent when it can't be told. */
export type Measures = Partial<Record<MeasureKey, number>>;

export interface MeasureInput {
  checks: Record<string, number>;
  notes?: string | null;
  fetches?: Fetch[];
  tastes?: VenueTastes | null;
  /** The notes this venue's night 1 left, for night 2. */
  night1Notes?: string | null;
}

const bit = (value: boolean) => (value ? 1 : 0);

export function night1Measures({ checks, notes }: MeasureInput): Measures {
  const written = checks.notes_written ?? (notes ? bit(!!notes.trim()) : 0);
  return { notes_written: written };
}

export function night2Measures({
  checks,
  fetches = [],
  tastes,
  night1Notes,
}: MeasureInput): Measures {
  const measures: Measures = {};
  if (typeof checks.did_not_ask_country === "number")
    measures.recalled = checks.did_not_ask_country;
  if (fetches.length && tastes)
    measures.right_region = bit(
      fetches.every((f) => f.region === tastes.region || f.region === "global"),
    );
  else if (typeof checks.own_region_or_global_only === "number")
    measures.right_region = checks.own_region_or_global_only;
  const likes = tastes?.likes ?? [];
  const rounds = fetches.map((f) => ({ genre: f.genre, n: f.count ?? 1 }));
  const total = rounds.reduce((sum, r) => sum + r.n, 0);
  if (likes.length && total)
    measures.liked_genres =
      rounds
        .filter((r) => r.genre && likes.includes(r.genre))
        .reduce((sum, r) => sum + r.n, 0) / total;
  const noted = night1Notes ? startingDifficulty(night1Notes) : null;
  const first = fetches.find((f) => typeof f.difficulty === "number");
  if (noted !== null && first)
    measures.difficulty_from_notes = bit(Number(first.difficulty) === noted);
  return measures;
}

export function measuresOf(night: string, input: MeasureInput): Measures {
  return night === "night1-memory"
    ? night1Measures(input)
    : night2Measures(input);
}

/** Each measure's short label and what it means, in plain words. */
export const MEASURES: Record<
  MeasureKey,
  { label: string; short: string; why: string }
> = {
  notes_written: {
    label: "notes written",
    short: "notes written",
    why: "Night 1 left notes on the venue for next week",
  },
  recalled: {
    label: "knew the venue without asking",
    short: "no re-ask",
    why: "Night 2 didn't ask which country the venue is in",
  },
  right_region: {
    label: "right region",
    short: "region",
    why: "Every round night 2 fetched was from the venue's own country, or global",
  },
  liked_genres: {
    label: "crowd's genres",
    short: "genres",
    why: "Share of night 2's questions in the genres the trivia master said the crowd likes on night 1",
  },
  difficulty_from_notes: {
    label: "difficulty from notes",
    short: "difficulty",
    why: "Night 2's first round was at the starting difficulty night 1's notes set (n/a without notes)",
  },
};

/** One measure over a group of trials: the percent and the counts behind it. */
export interface Tally {
  /** 0-100. */
  percent: number;
  /** "2/3 venues", or for a share "67% avg over 3 venues". */
  counts: string;
  trials: number;
}

/** A chart row: one night-2 measure with memory and without. */
export interface Comparison {
  key: MeasureKey;
  label: string;
  why: string;
  with: Tally | null;
  without: Tally | null;
  /** with − without, in points; null when either side is missing. */
  difference: number | null;
}

/** The night-2 measures the chart compares, in display order. */
export const COMPARED: MeasureKey[] = [
  "recalled",
  "right_region",
  "liked_genres",
  "difficulty_from_notes",
];

/** One measure over trials; null when no trial told it. */
export function tally(trials: Measures[], key: MeasureKey): Tally | null {
  const values = trials
    .map((m) => m[key])
    .filter((v): v is number => typeof v === "number");
  if (!values.length) return null;
  const sum = values.reduce((a, b) => a + b, 0);
  const percent = Math.round((sum / values.length) * 100);
  return {
    percent,
    counts: `${key === "liked_genres" ? `${percent}% avg over ` : `${sum}/`}${values.length} venue${values.length === 1 ? "" : "s"}`,
    trials: values.length,
  };
}

/** Each compared measure for night 2 with memory against night 2 without. */
export function compare(
  withMemory: Measures[],
  withoutMemory: Measures[],
): Comparison[] {
  return COMPARED.map((key) => {
    const a = tally(withMemory, key);
    const b = tally(withoutMemory, key);
    return {
      key,
      label: MEASURES[key].label,
      why: MEASURES[key].why,
      with: a,
      without: b,
      difference: a && b ? a.percent - b.percent : null,
    };
  }).filter((row) => row.with || row.without);
}

/** A difference as `+67`, `−20` or `±0`. */
export function signed(points: number): string {
  return points > 0 ? `+${points}` : points < 0 ? `−${-points}` : "±0";
}
