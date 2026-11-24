// The question supply in balanced cells (every genre x region x difficulty), the same in every
// world, so it lives here rather than in the state. The first REAL_PER_CELL of a cell are real
// questions from questions.jsonl (scripts/generate-questions.mjs); the rest are placeholders, sized
// so that no series empties a cell: a venue's longest series (4 nights of 5 rounds of 8) takes at
// most 160 questions, all from one cell at worst.
import { labelId } from "@introspection-ai/eval-simulate/mcp";
import type { Genre, Question, Region } from "./entities.ts";
import { readFileSync } from "node:fs";

type Real = Pick<Question, "format" | "text" | "options" | "answer" | "decade">;
// One question per line, in its cell's order: a question's id is its place in the cell.
const REAL: Record<string, Real[]> = {};
for (const line of readFileSync(
  new URL("./questions.jsonl", import.meta.url),
  "utf8",
).split("\n")) {
  if (!line.trim()) continue;
  const { cell, ...q } = JSON.parse(line) as Real & { cell: string };
  (REAL[cell] ??= []).push(q);
}

export const GENRES: Genre[] = [
  "music",
  "film",
  "sport",
  "science",
  "history",
  "geography",
];
export const REGIONS: Region[] = ["global", "au", "uk", "us"];
export const PER_CELL = 200;
export const REAL_PER_CELL = 60;

const WORDS = [
  "amber",
  "beacon",
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
];
const REGION_NAME: Record<Region, string> = {
  global: "general knowledge",
  au: "Australia",
  uk: "the UK",
  us: "the US",
};

let cache: Question[] | null = null;
let index: Map<string, Question> | null = null;
const real = new Set<string>();

export function supply(): Question[] {
  if (cache) return cache;
  const out: Question[] = [];
  for (const genre of GENRES)
    for (const region of REGIONS)
      for (let difficulty = 1; difficulty <= 5; difficulty++)
        for (let n = 0; n < PER_CELL; n++) {
          const id = labelId(`${genre}-${region}-${difficulty}-${n}`);
          const q =
            n < REAL_PER_CELL
              ? REAL[`${genre}-${region}-${difficulty}`][n]
              : undefined;
          if (q) real.add(id);
          out.push({
            id,
            genre,
            region,
            difficulty,
            ...(q ?? {
              format: "short",
              text: `Practice ${genre} question about ${REGION_NAME[region]}, level ${difficulty}, number ${n + 1}: which code word goes with this question?`,
              answer: WORDS[n % WORDS.length],
            }),
          });
        }
  cache = out;
  return out;
}

// The nights a series splits a venue's supply across, unless the world sets its own (series_nights):
// each night at a venue draws from its own share.
export const SERIES_NIGHTS = 4;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (const c of s) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** The night (1 to nights) a question belongs to at a venue: a stable FNV-1a hash of both. */
export function nightOf(
  venue: string,
  id: string,
  nights = SERIES_NIGHTS,
): number {
  return (fnv1a(`${venue}\u0000${id}`) % nights) + 1;
}

/**
 * The questions in the order a venue meets them on a night: real ones before placeholders, each
 * shuffled by a stable hash of venue, night and id, so venues differ but a request always repeats.
 */
export function shuffled(
  questions: Question[],
  venue: string,
  night: number,
): Question[] {
  const key = new Map(
    questions.map((q) => [q.id, fnv1a(`${venue}\u0000${night}\u0000${q.id}`)]),
  );
  return [...questions].sort(
    (a, b) =>
      Number(real.has(b.id)) - Number(real.has(a.id)) ||
      (key.get(a.id) as number) - (key.get(b.id) as number) ||
      a.id.localeCompare(b.id),
  );
}

export function question(id: string): Question | undefined {
  index ??= new Map(supply().map((q) => [q.id, q]));
  return index.get(id);
}
