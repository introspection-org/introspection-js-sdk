import type { State } from "../mcp/trivia-bank/entities.ts";
import { base } from "./base.ts";
import returning from "./returning.ts";
import secondWeek from "./second-week.ts";

export type World = { "trivia-bank": State };

export const SCENARIOS: Record<string, (world: World) => void> = {
  returning,
  "second-week": secondWeek,
};

export function world(
  scenario: string | undefined,
  _clock: Date,
  seed = 0,
): World {
  const w = base(seed);
  if (scenario === undefined) return w;
  const change = SCENARIOS[scenario];
  if (!change) throw new Error(`Unknown scenario: ${scenario}`);
  change(w);
  return w;
}
