// Writes fakes/world/heldout.ts: twenty held-out pubs for the trivia-night
// page, drawn with a fixed seed: each pub, its city and its teams. Their crowds,
// and so their tastes, are drawn from the venue's id by fakes/world/crowd.ts.
// Run `node recipe-operator/evals/heldout.mjs`, then `pnpm evals:venues` to
// write their tasks. The same seed always writes the same file.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SEED = 20261123;
const GENRES = ["music", "film", "sport", "science", "history", "geography"];

// Each city's stereotype is in fakes/world/stereotypes.ts.
const CITIES = [
  ["Adelaide", "au"],
  ["Hobart", "au"],
  ["Darwin", "au"],
  ["Canberra", "au"],
  ["Newcastle", "au"],
  ["Geelong", "au"],
  ["Cairns", "au"],
  ["Liverpool", "uk"],
  ["Birmingham", "uk"],
  ["Edinburgh", "uk"],
  ["Cardiff", "uk"],
  ["Nottingham", "uk"],
  ["Sheffield", "uk"],
  ["Belfast", "uk"],
  ["Denver", "us"],
  ["Austin", "us"],
  ["Portland", "us"],
  ["Atlanta", "us"],
  ["Nashville", "us"],
  ["Minneapolis", "us"],
];
const PUBS = [
  "The Red Lion",
  "The White Hart",
  "The Kings Arms",
  "The Plough",
  "The Rose and Crown",
  "The Fox",
  "The Bell",
  "The Ship",
  "The George",
  "The Wheatsheaf",
];
const TEAMS = [
  (c) => `The ${c} Brainiacs`,
  (c) => `${c} Know-It-Alls`,
  (c) => `Quizzy ${c}`,
  (c) => `The ${c} Regulars`,
  (c) => `${c} Smarty Pints`,
  (c) => `The ${c} Quizzards`,
  (c) => `${c} Fact Finders`,
  (c) => `The ${c} Thinkers`,
];
const NAMES = ["Sam", "Ali", "Jo", "Kim", "Lee", "Max", "Ruth", "Tom"];

/** A seeded generator of numbers in [0, 1): mulberry32. */
export function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const shuffle = (items, r) => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/** The twenty held-out pubs: a pub, its city, its teams and a one-night request. */
export function heldOutPubs(seed = SEED) {
  const r = random(seed);
  return CITIES.map(([city, region], i) => ({
    id: `held-${city.toLowerCase()}`,
    pub: PUBS[Math.floor(r() * PUBS.length)],
    city,
    region,
    request: {
      night: 3,
      genre: GENRES[Math.floor(r() * GENRES.length)],
      who: NAMES[i % NAMES.length],
    },
    teams: shuffle(
      TEAMS.map((team) => team(city)),
      r,
    ),
  }));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = path.join(here, "../fakes/world/heldout.ts");
  writeFileSync(
    file,
    `// Written by evals/heldout.mjs (seed ${SEED}); do not edit by hand.
import type { VenueBase } from "./profiles.ts";

export const HELDOUT_PUBS: VenueBase[] = ${JSON.stringify(heldOutPubs(), null, 2)};
`,
  );
  console.log(`wrote ${path.relative(process.cwd(), file)}`);
}
