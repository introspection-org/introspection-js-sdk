// The synthetic question supply. Text and answers are placeholders: no score
// depends on what a question says, only on its genre, region and difficulty.
// The supply is held as a count per cell (genre, region, level), so a world
// can hold thousands of questions in a small JSON state; a question's text and
// answer are derived from its id.
import type { Question } from "../mcp/question-bank/entities.ts";

export const GENRES = [
  "music",
  "film",
  "tv",
  "sport",
  "history",
  "geography",
  "science",
  "food-and-drink",
  "literature",
  "christmas",
] as const;
export const REGIONS = ["general", "AU", "UK", "US"] as const;
export type Region = (typeof REGIONS)[number];

/**
 * Questions per genre, region and level. The longest series is 3 nights x 3
 * rounds x 10 = 90 questions; a venue's eligible cells for one genre and level
 * (its region + general) hold 600, and one cell alone 300, so even a host that plays one genre at one
 * level from one region all series uses under a third of one cell.
 */
export const PER_CELL: Record<Region, number> = {
  general: 300,
  AU: 300,
  UK: 300,
  US: 300,
};

export const cellKey = (genre: string, region: string, level: number) =>
  `${genre}|${region}|${level}`;

export function fullSupply(): Record<string, number> {
  const supply: Record<string, number> = {};
  for (const g of GENRES)
    for (const r of REGIONS)
      for (let d = 1; d <= 5; d++) supply[cellKey(g, r, d)] = PER_CELL[r];
  return supply;
}

const WORDS = [
  "amber",
  "bishop",
  "cobalt",
  "delta",
  "ember",
  "falcon",
  "garnet",
  "harbour",
  "indigo",
  "juniper",
  "kestrel",
  "lantern",
  "marble",
  "nectar",
  "onyx",
  "pepper",
  "quartz",
  "raven",
  "saffron",
  "thistle",
];
export const REGION_LABEL: Record<Region, string> = {
  general: "anywhere",
  AU: "Australia",
  UK: "the UK",
  US: "the US",
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export const idOf = (genre: string, region: Region, level: number, k: number) =>
  `q-${genre}-${region.toLowerCase()}-${level}-${String(k).padStart(3, "0")}`;

export function answerOf(id: string): string {
  const h = hash(id);
  return `${WORDS[h % 20]} ${WORDS[Math.floor(h / 20) % 20]}`;
}

/** A wrong answer a team might give: a different word pair. */
export function wrongOf(id: string, salt: string): string {
  const right = answerOf(id);
  for (let i = 0; ; i++) {
    const h = hash(`${id}:${salt}:${i}`);
    const w = `${WORDS[h % 20]} ${WORDS[Math.floor(h / 20) % 20]}`;
    if (w !== right) return w;
  }
}

export function questionOf(
  genre: string,
  region: Region,
  level: number,
  k: number,
): Question {
  const id = idOf(genre, region, level, k);
  return {
    id,
    genre,
    region,
    difficulty: level,
    text: `Sample ${genre} question for ${REGION_LABEL[region]}, level ${level}, no. ${k}: which code word pair goes with it?`,
    answer: answerOf(id),
  };
}

const ID = /^q-([a-z-]+)-(general|au|uk|us)-([1-5])-(\d{3})$/;
export function parseId(id: string): Question | null {
  const m = ID.exec(id);
  if (!m) return null;
  const region = (
    m[2] === "general" ? "general" : m[2].toUpperCase()
  ) as Region;
  return questionOf(m[1], region, Number(m[3]), Number(m[4]));
}

// The bank's text, as a host may pass it on: "for <region>" may be reworded
// (", general", ", UK") or dropped, which leaves a general question.
const TEXT =
  /Sample ([a-z-]+) question(?:,? (?:for )?(anywhere|general|Australia|AU|the UK|UK|the US|US))?, level ([1-5]), no\. (\d+)/gi;
const REGION_WORD: Record<string, Region> = {
  anywhere: "general",
  general: "general",
  australia: "AU",
  au: "AU",
  "the uk": "UK",
  uk: "UK",
  "the us": "US",
  us: "US",
};
/** The questions whose bank text appears in a message, in order of appearance. */
export function questionsIn(message: string): Question[] {
  const out: Question[] = [];
  for (const m of message.matchAll(TEXT)) {
    const genre = m[1].toLowerCase();
    const region =
      m[2] === undefined ? "general" : REGION_WORD[m[2].toLowerCase()];
    if (!(GENRES as readonly string[]).includes(genre) || !region) continue;
    const q = questionOf(genre, region, Number(m[3]), Number(m[4]));
    if (!out.some((o) => o.id === q.id)) out.push(q);
  }
  return out;
}
