// Who turns up to a pub quiz in each country: age bands and interest archetypes, with weights.
// Illustrative, not census-accurate: the age mixes lean on the shape of adult age pyramids
// (ABS, ONS and US Census estimates) tilted towards the 25-44s who make up most pub-quiz teams,
// and the archetypes on the broad pattern of what quiz-goers say they follow (sport heavier in
// Australia, music and history in the UK, film and sport in the US). Constants, so every crowd
// drawn from them repeats exactly.
import type { Genre, Region } from "../mcp/trivia-bank/entities.ts";

export type Country = Exclude<Region, "global">;
export type AgeBand = { from: number; to: number; weight: number };
/** An interest archetype: how keen a member of it is on each genre, 0 (none) to 1 (devoted). */
export type Archetype = {
  name: string;
  weight: number;
  interest: Record<Genre, number>;
};
export type Demographics = { ages: AgeBand[]; archetypes: Archetype[] };

const i = (
  music: number,
  film: number,
  sport: number,
  science: number,
  history: number,
  geography: number,
): Record<Genre, number> => ({
  music,
  film,
  sport,
  science,
  history,
  geography,
});

// The same eight archetypes everywhere; only how common each is changes by country.
const ARCHETYPES: Record<string, Record<Genre, number>> = {
  "sports fan": i(0.35, 0.3, 0.95, 0.2, 0.3, 0.3),
  "music head": i(0.95, 0.5, 0.25, 0.2, 0.25, 0.25),
  "film buff": i(0.5, 0.95, 0.2, 0.25, 0.35, 0.25),
  "science nerd": i(0.25, 0.4, 0.2, 0.95, 0.4, 0.45),
  "history buff": i(0.3, 0.35, 0.3, 0.35, 0.95, 0.6),
  traveller: i(0.35, 0.35, 0.3, 0.35, 0.55, 0.95),
  "all-rounder": i(0.6, 0.6, 0.55, 0.55, 0.6, 0.6),
  casual: i(0.45, 0.45, 0.4, 0.2, 0.2, 0.25),
};

const mix = (weights: Record<string, number>): Archetype[] =>
  Object.entries(weights).map(([name, weight]) => ({
    name,
    weight,
    interest: ARCHETYPES[name],
  }));

export const DEMOGRAPHICS: Record<Country, Demographics> = {
  au: {
    ages: [
      { from: 18, to: 24, weight: 0.14 },
      { from: 25, to: 34, weight: 0.27 },
      { from: 35, to: 44, weight: 0.23 },
      { from: 45, to: 54, weight: 0.16 },
      { from: 55, to: 64, weight: 0.12 },
      { from: 65, to: 75, weight: 0.08 },
    ],
    archetypes: mix({
      "sports fan": 0.22,
      "music head": 0.13,
      "film buff": 0.12,
      "science nerd": 0.1,
      "history buff": 0.09,
      traveller: 0.12,
      "all-rounder": 0.12,
      casual: 0.1,
    }),
  },
  uk: {
    ages: [
      { from: 18, to: 24, weight: 0.13 },
      { from: 25, to: 34, weight: 0.24 },
      { from: 35, to: 44, weight: 0.21 },
      { from: 45, to: 54, weight: 0.17 },
      { from: 55, to: 64, weight: 0.14 },
      { from: 65, to: 75, weight: 0.11 },
    ],
    archetypes: mix({
      "sports fan": 0.17,
      "music head": 0.17,
      "film buff": 0.11,
      "science nerd": 0.1,
      "history buff": 0.14,
      traveller: 0.09,
      "all-rounder": 0.12,
      casual: 0.1,
    }),
  },
  us: {
    ages: [
      { from: 18, to: 24, weight: 0.12 },
      { from: 25, to: 34, weight: 0.28 },
      { from: 35, to: 44, weight: 0.24 },
      { from: 45, to: 54, weight: 0.15 },
      { from: 55, to: 64, weight: 0.12 },
      { from: 65, to: 75, weight: 0.09 },
    ],
    archetypes: mix({
      "sports fan": 0.19,
      "music head": 0.13,
      "film buff": 0.17,
      "science nerd": 0.12,
      "history buff": 0.1,
      traveller: 0.07,
      "all-rounder": 0.12,
      casual: 0.1,
    }),
  },
};
