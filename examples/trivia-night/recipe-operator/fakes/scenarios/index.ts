import type { State } from "../mcp/trivia-bank/entities.ts";
import type { SubjectState } from "../mcp/subject/entities.ts";
import { ALL, CASES } from "../world/profiles.ts";
import { base } from "./base.ts";
import returning from "./returning.ts";
import secondWeek from "./second-week.ts";

export type World = { "trivia-bank": State; subject: SubjectState };

// One scenario per venue a memory search plays: it sets the venue's profile, nothing else.
const venues = Object.fromEntries(
  ALL.map((p) => [
    p.id,
    (w: World) => {
      w["trivia-bank"].venue = p.id;
      w.subject.venue = p.id;
    },
  ]),
);

// The approved cases' worlds: the bank's history from a scenario, the case's venue, and the trivia master
// at the night before the case starts.
const at =
  (venue: string, nightsBefore: number, history?: (w: World) => void) =>
  (w: World) => {
    history?.(w);
    w["trivia-bank"].venue = venue;
    w.subject.venue = venue;
    w.subject.conversation.night = nightsBefore;
  };
const cases = {
  "case-c1": at("case-c1", 3, returning),
  "case-c2": at("case-c2", 1, secondWeek),
  "case-c3": at("case-c3", 0),
};
void CASES;

export const SCENARIOS: Record<string, (world: World) => void> = {
  returning,
  "second-week": secondWeek,
  ...venues,
  ...cases,
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
