// The base world: a venue the bank has never hosted, and a synthetic question
// supply in balanced cells (every genre x region x difficulty). Synthetic text
// only; no real bank question is copied here.
import { labelId } from "@introspection-ai/eval-simulate/mcp";
import type {
  Genre,
  Question,
  Region,
  State,
} from "../mcp/trivia-bank/entities.ts";

export const GENRES: Genre[] = [
  "music",
  "film",
  "sport",
  "science",
  "history",
  "geography",
];
export const REGIONS: Region[] = ["global", "au", "uk", "us"];
export const PER_CELL = 12;

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

export function questionSupply(): Question[] {
  const out: Question[] = [];
  for (const genre of GENRES)
    for (const region of REGIONS)
      for (let difficulty = 1; difficulty <= 5; difficulty++)
        for (let n = 0; n < PER_CELL; n++) {
          const label = `${genre}-${region}-${difficulty}-${n}`;
          out.push({
            id: labelId(label),
            genre,
            region,
            difficulty,
            text: `Practice ${genre} question about ${REGION_NAME[region]}, level ${difficulty}, number ${n + 1}: which code word goes with this question?`,
            answer: WORDS[n],
          });
        }
  return out;
}

export function base(seed: number): { "trivia-bank": State } {
  return {
    "trivia-bank": {
      seed,
      questions: questionSupply(),
      nights: [],
      asked: [],
      marks: [],
    },
  };
}
