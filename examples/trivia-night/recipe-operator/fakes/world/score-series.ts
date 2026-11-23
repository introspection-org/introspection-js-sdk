// node world/score-series.ts <series-dir>: prints one series' scores as JSON.
// The series folder holds state.json (the fakes) and memory-after-<n>/ per night.
import fs from "node:fs";
import path from "node:path";
import { scoreNight } from "./score.ts";

const dir = process.argv[2];
const state = JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8"));
const bank = state["trivia-bank"];
const nights = bank.nights.map((n: { week: number }) => n.week);
const readNotes = (n: number) => {
  const d = path.join(dir, `memory-after-${n}`);
  if (!fs.existsSync(d)) return "";
  return fs
    .readdirSync(d, { recursive: true })
    .map(String)
    .filter((f) => fs.statSync(path.join(d, f)).isFile())
    .map((f) => fs.readFileSync(path.join(d, f), "utf8"))
    .join("\n");
};
console.log(
  JSON.stringify(
    {
      venue: bank.venue,
      nights: nights.map((n: number) =>
        scoreNight(bank, bank.venue, n, readNotes(n)),
      ),
    },
    null,
    1,
  ),
);
