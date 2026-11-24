// A venue's crowd as people: eight teams of three to six members, each drawn from the venue
// country's demographic mix (demographics.ts) with a seed from the venue's id, so the same venue
// always seats the same teams. A team answers right when any member knows the answer, less a
// discount for talking itself out of it.
import { randomOf } from "@introspection-ai/eval-simulate/mcp";
import type { Genre, Region } from "../mcp/trivia-bank/entities.ts";
import {
  DEMOGRAPHICS,
  type Country,
  type Demographics,
} from "./demographics.ts";

export const GENRES: Genre[] = [
  "music",
  "film",
  "sport",
  "science",
  "history",
  "geography",
];
export const DECADES = [
  "1960s",
  "1970s",
  "1980s",
  "1990s",
  "2000s",
  "2010s",
  "2020s",
];
/** The year the crowd's ages are counted in. */
export const YEAR = 2026;

export type Member = {
  age: number;
  interest: Record<Genre, number>;
  local: true;
};
export type Team = { name: string; members: Member[] };
export type Asked = {
  genre: Genre;
  region: Region;
  difficulty: number;
  decade?: string;
};

// P(member knows q) = logistic(A + B·interest + C·cohort + D·(local or global ? 1 : -3) - E·difficulty).
// Calibrated (evals/crowd-report.mjs) so a typical team at difficulty 3 gets about 70% of its favourite
// genre right and about 40% of its least favourite, and all-star teams are rare.
export const MODEL = {
  A: -1.8,
  B: 2.4,
  C: 1.1,
  D: 1.0,
  E: 0.75,
  // Conferring: a team that holds the answer still writes it down nine times in ten.
  CONFER: 0.9,
  // A question with no decade (a placeholder) counts as a middling cohort fit.
  COHORT_NEUTRAL: 0.4,
};

const pick = <T extends { weight: number }>(items: T[], r: () => number) => {
  let x = r() * items.reduce((s, item) => s + item.weight, 0);
  for (const item of items) if ((x -= item.weight) < 0) return item;
  return items[items.length - 1];
};
const clamp = (x: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, x));
const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * A venue's own mix: its country's, tilted by the venue's scene (a sports pub, a student bar),
 * so venues in one country differ. Each weight is scaled by a factor from 0.3 to 3.3 for an
 * archetype and 0.45 to 2.2 for an age band, from a seed stream keyed by the venue and the draw.
 */
export function venueMix(
  venueId: string,
  region: Country,
  attempt = 0,
): Demographics {
  const r = randomOf(0, "scene", venueId, attempt);
  const { ages, archetypes } = DEMOGRAPHICS[region];
  return {
    ages: ages.map((a) => ({
      ...a,
      weight: a.weight * Math.exp(0.8 * (2 * r() - 1)),
    })),
    archetypes: archetypes.map((a) => ({
      ...a,
      weight: a.weight * Math.exp(1.6 * (2 * r() - 1)),
    })),
  };
}

/**
 * One team: friends of about one age (one in four from anywhere in the mix), half of them of
 * the team's own leaning and the rest of any archetype.
 */
export function sampleTeam(r: () => number, mix: Demographics, name: string) {
  const { ages, archetypes } = mix;
  const band = pick(ages, r);
  const centre = band.from + r() * (band.to - band.from);
  const lean = pick(archetypes, r);
  const size = 3 + Math.floor(r() * 4);
  const members: Member[] = [];
  for (let k = 0; k < size; k++) {
    const own = r() < 0.25 ? pick(ages, r) : null;
    const age = own
      ? own.from + r() * (own.to - own.from)
      : centre + (r() * 12 - 6);
    const type = r() < 0.6 ? lean : pick(archetypes, r);
    members.push({
      age: Math.round(clamp(age, 18, 80)),
      interest: Object.fromEntries(
        GENRES.map((g) => [
          g,
          round2(clamp(type.interest[g] + (r() * 0.2 - 0.1), 0, 1)),
        ]),
      ) as Record<Genre, number>,
      local: true,
    });
  }
  return { name, members };
}

/** A venue's regulars, one team per name, from a seed stream keyed by the venue and the draw (attempt). */
export function sampleCrowd(
  venueId: string,
  region: Country,
  names: string[],
  attempt = 0,
): Team[] {
  const mix = venueMix(venueId, region, attempt);
  return names.map((name, i) =>
    sampleTeam(randomOf(0, "crowd", venueId, attempt, i), mix, name),
  );
}

/** New teams for a later night, from the venue's own mix but their own seed stream, so the regulars never change. */
export function sampleNewcomers(
  venueId: string,
  region: Country,
  names: string[],
  attempt = 0,
): Team[] {
  const mix = venueMix(venueId, region, attempt);
  return names.map((name, i) =>
    sampleTeam(randomOf(0, "newcomers", venueId, attempt, i), mix, name),
  );
}

/** How much of a decade a member lived through between the ages of about 10 and 35, 0 to 1. */
export function cohort(decade: string | undefined, age: number): number {
  const start = decade ? Number.parseInt(decade, 10) : NaN;
  if (!Number.isFinite(start)) return MODEL.COHORT_NEUTRAL;
  const born = YEAR - age;
  const overlap =
    Math.min(start + 9, born + 35, YEAR) - Math.max(start, born + 10) + 1;
  const span = Math.min(start + 9, YEAR) - start + 1;
  return clamp(overlap / span, 0, 1);
}

const logistic = (x: number) => 1 / (1 + Math.exp(-x));

/** The chance one member knows the answer; `shift` moves a hand-set venue's whole crowd. */
export function memberChance(
  m: Member,
  q: Asked,
  venueRegion: Region,
  shift = 0,
): number {
  const home = q.region === "global" || q.region === venueRegion ? 1 : -3;
  return logistic(
    MODEL.A +
      shift +
      MODEL.B * m.interest[q.genre] +
      MODEL.C * cohort(q.decade, m.age) +
      MODEL.D * home -
      MODEL.E * q.difficulty,
  );
}

/** The chance a team writes the right answer: any member knows it, discounted for conferring. */
export function teamChance(
  team: Team,
  q: Asked,
  venueRegion: Region,
  shift = 0,
): number {
  const none = team.members.reduce(
    (s, m) => s * (1 - memberChance(m, q, venueRegion, shift)),
    1,
  );
  return MODEL.CONFER * (1 - none);
}

/** A team's mean interest in each genre. */
export function teamInterest(team: Team): Record<Genre, number> {
  return Object.fromEntries(
    GENRES.map((g) => [
      g,
      team.members.reduce((s, m) => s + m.interest[g], 0) / team.members.length,
    ]),
  ) as Record<Genre, number>;
}

/** The crowd's taste in each genre: the mean interest over every member. */
export function crowdInterest(teams: Team[]): Record<Genre, number> {
  const members = teams.flatMap((t) => t.members);
  return Object.fromEntries(
    GENRES.map((g) => [
      g,
      round2(members.reduce((s, m) => s + m.interest[g], 0) / members.length),
    ]),
  ) as Record<Genre, number>;
}

/** Genres from most to least enjoyed, ties in GENRES order. */
export const ranked = (enjoy: Record<Genre, number>) =>
  [...GENRES].sort((a, b) => enjoy[b] - enjoy[a]);

/** A team's expected share right over the bank's decades and the venue's two question regions. */
export function expected(
  teams: Team[],
  genres: Genre[],
  difficulty: number,
  region: Region,
  { decades = DECADES, shift = 0 }: { decades?: string[]; shift?: number } = {},
): number {
  let sum = 0;
  let n = 0;
  for (const team of teams)
    for (const genre of genres)
      for (const r of [region, "global"] as Region[])
        for (const decade of decades) {
          sum += teamChance(
            team,
            { genre, region: r, difficulty, decade },
            region,
            shift,
          );
          n += 1;
        }
  return n ? sum / n : 0;
}

/** A team's strength: its expected share right over every genre at difficulty 3. */
export const strength = (team: Team, region: Region) =>
  expected([team], GENRES, 3, region);
