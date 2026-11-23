import type { State as Bank } from "../mcp/question-bank/entities.ts";
import type { State as Subject } from "../mcp/subject/entities.ts";
import { fullSupply } from "./bank.ts";

export type World = { "question-bank": Bank; subject: Subject };

export function base(_clock: Date, seed: number): World {
  return {
    "question-bank": { supply: fullSupply(), asked: [], rounds: [] },
    subject: { seed, venue: null, nights: [] },
  };
}
