/** The page's own state: the nights played so far at each venue, per host. */
import { askedIds, reset, week } from "./bank";
import { clearEvents, record } from "./events";
import { attentive, forgetful, notesFile, resetNotes, type Host } from "./host";
import { owner, playNight, type NightResult } from "./night";
import { QUESTIONS } from "./questions";
import { VENUES } from "./venues";

const HOSTS: Record<Host["name"], Host> = { forgetful, attentive };
const SEED = 1;

const store = globalThis as unknown as {
  __triviaDemo?: { nights: NightResult[]; asked: Map<string, Set<string>> };
};
const demo = (store.__triviaDemo ??= {
  nights: [] as NightResult[],
  asked: new Map<string, Set<string>>(),
});

export function play(venueId: string, hostName: string): NightResult {
  const venue = VENUES.find((item) => item.id === venueId);
  const host = HOSTS[hostName as Host["name"]];
  if (!venue || !host) throw new Error("unknown venue or host");
  const who = owner(venue, host);
  let asked = demo.asked.get(who);
  if (!asked) demo.asked.set(who, (asked = new Set()));
  const night = playNight(venue, host, SEED, asked, record);
  demo.nights.push(night);
  return night;
}

export function restart(): void {
  reset();
  resetNotes();
  clearEvents();
  demo.nights.length = 0;
  demo.asked.clear();
}

export function state() {
  return {
    bank_size: QUESTIONS.length,
    venues: VENUES.map((venue) => ({
      id: venue.id,
      name: venue.name,
      region: venue.region,
      likes: venue.likes,
      held_out: venue.heldOut,
      hosts: (Object.keys(HOSTS) as Host["name"][]).map((name) => {
        const who = owner(venue, HOSTS[name]);
        return {
          host: name,
          owner: who,
          week: week(who),
          asked: askedIds(who).length,
          notes: notesFile(who) ?? null,
          nights: demo.nights
            .filter((night) => night.venue === venue.id && night.host === name)
            .map(({ summary: _summary, ...night }) => night),
        };
      }),
    })),
  };
}
