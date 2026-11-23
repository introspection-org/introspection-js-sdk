// The base world: a venue the bank has never hosted. The question supply is the
// same in every world (mcp/trivia-bank/supply.ts).
import type { State } from "../mcp/trivia-bank/entities.ts";
import type { SubjectState } from "../mcp/subject/entities.ts";

export function base(seed: number): {
  "trivia-bank": State;
  subject: SubjectState;
} {
  return {
    "trivia-bank": { seed, venue: null, nights: [], asked: [], marks: [] },
    subject: {
      seed,
      venue: null,
      conversation: { night: 0, phase: "closed", roundsTonight: 0 },
    },
  };
}
