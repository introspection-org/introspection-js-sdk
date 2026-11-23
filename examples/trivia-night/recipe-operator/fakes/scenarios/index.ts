import { VENUES } from "../venues.ts";
import { base, type World } from "./base.ts";
import usSportScarce from "./us-sport-scarce.ts";

export type { World };

/** One scenario per simulated venue: the venue whose trivia master the host meets. */
const venueScenarios = Object.fromEntries(
  VENUES.map((v) => [
    `venue-${v.id}`,
    (w: World) => {
      w.subject.venue = structuredClone(v);
    },
  ]),
);

export const SCENARIOS: Record<string, (w: World) => void> = {
  base: () => {},
  "us-sport-scarce": usSportScarce,
  ...venueScenarios,
};

export function world(
  name: string = "base",
  clock: Date = new Date(),
  seed = 0,
): World {
  const change = SCENARIOS[name];
  if (!change)
    throw new Error(
      `Unknown scenario "${name}". Scenarios: ${Object.keys(SCENARIOS).join(", ")}.`,
    );
  const w = base(clock, seed);
  change(w);
  return w;
}
