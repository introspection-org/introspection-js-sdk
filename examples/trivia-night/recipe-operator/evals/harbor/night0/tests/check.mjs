// The pub this trial plays comes from its metadata (or TRIVIA_* variables), and its truth from
// evals/venues.json and evals/heldout.json, which an eval task keeps beside its tests.
import { readFileSync } from "node:fs";

import { check } from "../../../trivia-check.mjs";
import { perfectNotes, trialOf, venueNamed } from "../../../trivia-tasks.mjs";

const read = (file) =>
  JSON.parse(
    readFileSync(new URL(`../../../${file}`, import.meta.url), "utf8"),
  );
const trial = trialOf(process.env);
const venue = venueNamed(
  [read("venues.json"), read("heldout.json")],
  trial.pub,
);
await check({ night: 0, seeded: perfectNotes(venue) });
