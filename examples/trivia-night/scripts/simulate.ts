/**
 * Play several weeks at every simulated venue with both stand-in hosts, and
 * print how each did. No platform and no model: `pnpm simulate`.
 */
import { reset } from "../lib/bank";
import { attentive, forgetful, resetNotes, type Host } from "../lib/host";
import { playNight, type NightResult } from "../lib/night";
import { resetScores } from "../lib/scorer";
import { VENUES } from "../lib/venues";

const WEEKS = Number(process.env.WEEKS ?? 4);
const SEED = Number(process.env.SEED ?? 1);

export function simulate(weeks = WEEKS, seed = SEED): NightResult[] {
  reset();
  resetNotes();
  resetScores();
  const nights: NightResult[] = [];
  for (const host of [forgetful, attentive] satisfies Host[])
    for (const venue of VENUES) {
      const everAsked = new Set<string>();
      for (let week = 0; week < weeks; week += 1)
        nights.push(playNight(venue, host, seed, everAsked));
    }
  return nights;
}

const pct = (value: number) => `${Math.round(value * 100)}%`;

function table(nights: NightResult[], weeks: number): string {
  const lines = [
    "| Host | Venues | Week | Right | Pitch miss | Rounds pitched right | Rounds the crowd asked for | Unfair questions | Repeats |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const host of ["forgetful", "attentive"])
    for (const heldOut of [false, true])
      for (let week = 1; week <= weeks; week += 1) {
        const rows = nights.filter(
          (night) =>
            night.host === host &&
            night.week === week &&
            VENUES.find((venue) => venue.id === night.venue)!.heldOut ===
              heldOut,
        );
        const sum = (pick: (night: NightResult) => number) =>
          rows.reduce((total, night) => total + pick(night), 0);
        const rounds = sum((night) => night.rounds);
        lines.push(
          `| ${host} | ${heldOut ? "held out" : "tuning"} | ${week} | ` +
            `${pct(sum((night) => night.rate) / rows.length)} | ` +
            `${Math.round((100 * sum((night) => night.pitch_miss)) / rows.length)} pts | ` +
            `${sum((night) => night.rounds_on_target)}/${rounds} | ` +
            `${sum((night) => night.liked_rounds)}/${rounds} | ` +
            `${sum((night) => night.unfair_questions)} | ` +
            `${sum((night) => night.repeats)} |`,
        );
      }
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const nights = simulate();
  console.log(table(nights, WEEKS));
}
