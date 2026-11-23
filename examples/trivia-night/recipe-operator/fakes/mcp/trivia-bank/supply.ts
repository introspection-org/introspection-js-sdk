// The question supply: synthetic placeholders in balanced cells (every genre x
// region x difficulty), the same in every world, so it lives here rather than in
// the state. Sized so that no series empties a cell: a venue's longest series
// (4 nights of 5 rounds of 8) takes at most 160 questions, all from one cell at worst.
import { labelId } from "@introspection-ai/eval-simulate/mcp";
import type { Genre, Question, Region } from "./entities.ts";

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

export function supply(): Question[] {
  if (cache) return cache;
  const out: Question[] = [];
  for (const genre of GENRES)
    for (const region of REGIONS)
      for (let difficulty = 1; difficulty <= 5; difficulty++)
        for (let n = 0; n < PER_CELL; n++)
          out.push({
            id: labelId(`${genre}-${region}-${difficulty}-${n}`),
            genre,
            region,
            difficulty,
            text: `Practice ${genre} question about ${REGION_NAME[region]}, level ${difficulty}, number ${n + 1}: which code word goes with this question?`,
            answer: WORDS[n % WORDS.length],
          });
  cache = out;
  return out;
}

export function question(id: string): Question | undefined {
  index ??= new Map(supply().map((q) => [q.id, q]));
  return index.get(id);
}
