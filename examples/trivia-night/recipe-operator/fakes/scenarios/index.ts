import type { State } from "../mcp/trivia-bank/entities.ts";
import type { SubjectState } from "../mcp/subject/entities.ts";
import { ALL, CASES, CROWD_SIZES, HELDOUT, PAGE } from "../world/profiles.ts";
import { SERIES_NIGHTS } from "../mcp/trivia-bank/supply.ts";
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

// The same venues for the platform evals: the crowd answers each question as it's served.
const crowds = Object.fromEntries(
  [...ALL, ...PAGE, ...HELDOUT].map((p) => [
    `crowd-${p.id}`,
    (w: World) => {
      w["trivia-bank"].venue = p.id;
      w.subject.venue = p.id;
      w["trivia-bank"].crowd = true;
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
  ...crowds,
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
  const night = seriesNight(process.env.EVAL_SIMULATE_NIGHT);
  if (night !== undefined) w["trivia-bank"].series_night = night;
  const teams = crowdSize(process.env.EVAL_SIMULATE_TEAMS);
  if (teams !== undefined) w["trivia-bank"].crowd_size = teams;
  return w;
}

/** `EVAL_SIMULATE_TEAMS`, how many of the venue's teams a crowd plays (one of CROWD_SIZES); unset or empty is the default. */
export function crowdSize(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const teams = Number(value);
  if (!(CROWD_SIZES as readonly number[]).includes(teams))
    throw new Error(
      `EVAL_SIMULATE_TEAMS must be one of ${CROWD_SIZES.join(", ")}: ${value}`,
    );
  return teams;
}

/** `EVAL_SIMULATE_NIGHT`, the night of the series a sandbox plays (1 to SERIES_NIGHTS); unset or empty is none. */
export function seriesNight(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const night = Number(value);
  if (!Number.isInteger(night) || night < 1 || night > SERIES_NIGHTS)
    throw new Error(
      `EVAL_SIMULATE_NIGHT must be a night from 1 to ${SERIES_NIGHTS}: ${value}`,
    );
  return night;
}
