// The venues a memory search plays: what differs between them, as data.
// Training venues are written by hand; held-out venues are drawn with a fixed
// seed (heldOut()) over the same ranges and committed before any candidate runs.
import { randomOf } from "@introspection-ai/eval-simulate/mcp";
import type { Genre, Region } from "../mcp/trivia-bank/entities.ts";

export const GENRES: Genre[] = [
  "music",
  "film",
  "sport",
  "science",
  "history",
  "geography",
];

export type Profile = {
  id: string;
  pub: string;
  city: string;
  region: Exclude<Region, "global">; // the venue's own country
  level: number; // the difficulty this crowd answers about two in three right, on an average genre (1-5)
  skill: Record<Genre, number>; // per-genre offset to level (-1..+1)
  enjoy: Record<Genre, number>; // how much the crowd enjoys a genre (0..1); shown only in the trivia master's remarks
  enjoyFromNight3: Record<Genre, number> | null; // a crowd whose taste changes from night 3
  stated: Genre[]; // what the trivia master says on night 1 that the crowd likes (mostly, not always, what it enjoys)
  request: { night: number; genre: Genre; who: string }; // a request for that night only
  teams: string[];
  openings?: Record<number, string>; // the trivia master's exact opening on a given night (an approved case's words)
  rounds?: number; // rounds the trivia master runs tonight before calling time (default 3, as the memory search agreed)
};

const g = (
  music: number,
  film: number,
  sport: number,
  science: number,
  history: number,
  geography: number,
): Record<Genre, number> => ({
  music,
  film,
  sport,
  science,
  history,
  geography,
});

export const TRAINING: Profile[] = [
  {
    id: "au-film",
    pub: "The Lord Nelson",
    city: "Sydney",
    region: "au",
    level: 3.8,
    skill: g(0.5, 0.6, 0, -0.5, -0.2, 0),
    enjoy: g(0.85, 0.9, 0.5, 0.2, 0.4, 0.45),
    enjoyFromNight3: null,
    stated: ["film", "music"],
    request: { night: 3, genre: "science", who: "Priya" },
    teams: ["Quizzly Bears", "Les Quizerables", "Trivia Newton-John"],
  },
  {
    id: "uk-sport",
    pub: "The Crown",
    city: "Manchester",
    region: "uk",
    level: 2.2,
    skill: g(-0.3, -0.2, 0.6, -0.4, 0.4, -0.2),
    enjoy: g(0.4, 0.35, 0.9, 0.25, 0.8, 0.45),
    enjoyFromNight3: null,
    stated: ["sport"],
    request: { night: 2, genre: "music", who: "Dave" },
    teams: ["The Mancunian Candidates", "Quiz Team Aguilera", "Agatha Quiztie"],
  },
  {
    id: "us-science",
    pub: "Kelly's Tap",
    city: "Chicago",
    region: "us",
    level: 3.0,
    skill: g(0, 0, -0.3, 0.5, -0.2, 0.4),
    enjoy: g(0.45, 0.5, 0.3, 0.85, 0.4, 0.8),
    enjoyFromNight3: null,
    stated: ["science"],
    request: { night: 3, genre: "film", who: "Marcus" },
    teams: ["Smarty Pints", "The Quizzards", "Universally Challenged"],
  },
];

const PUBS: [string, string, Profile["region"]][] = [
  ["The Royal Oak", "Leeds", "uk"],
  ["The Esplanade", "Melbourne", "au"],
  ["Murphy's", "Boston", "us"],
  ["The Swan", "Bristol", "uk"],
  ["The Grand", "Brisbane", "au"],
  ["Dockside", "Seattle", "us"],
  ["The Anchor", "Glasgow", "uk"],
  ["The Railway", "Perth", "au"],
];
const KINDS = [
  "narrow",
  "shifting",
  "mismatch",
  "low",
  "high",
  "narrow",
  "shifting",
  "mismatch",
] as const;
const NAMES = ["Sam", "Ali", "Jo", "Kim", "Lee", "Max", "Ruth", "Tom"];

/** Eight held-out venues, drawn with a fixed seed over the training ranges, each of one kind. */
export function heldOut(seed = 4242): Profile[] {
  return PUBS.map(([pub, city, region], i) => {
    const r = randomOf(seed, "held-out", i);
    const kind = KINDS[i];
    const order = [...GENRES].sort(() => r() - 0.5);
    const enjoy = Object.fromEntries(
      GENRES.map((x) => [x, 0.25 + r() * 0.3]),
    ) as Record<Genre, number>;
    const liked = kind === "narrow" ? [order[0]] : [order[0], order[1]];
    for (const x of liked) enjoy[x] = 0.8 + r() * 0.15;
    const skill = Object.fromEntries(
      GENRES.map((x) => [x, Math.round((r() * 1.2 - 0.6) * 10) / 10]),
    ) as Record<Genre, number>;
    let enjoyFromNight3: Record<Genre, number> | null = null;
    if (kind === "shifting") {
      enjoyFromNight3 = { ...enjoy };
      for (const x of liked) enjoyFromNight3[x] = 0.3;
      enjoyFromNight3[order[2]] = 0.9;
      enjoyFromNight3[order[3]] = 0.85;
    }
    const level =
      kind === "low"
        ? 1.6
        : kind === "high"
          ? 4.4
          : Math.round((2 + r() * 2) * 10) / 10;
    const stated = kind === "mismatch" ? [order[4]] : [liked[0]];
    const requestGenre = order[5];
    return {
      id: `held-${i + 1}-${kind}`,
      pub,
      city,
      region,
      level,
      skill,
      enjoy,
      enjoyFromNight3,
      stated,
      request: { night: 2 + (i % 2), genre: requestGenre, who: NAMES[i] },
      teams: [
        `${city} Brainiacs`,
        `Quiz Pro Quo ${i + 1}`,
        `The ${pub.split(" ").at(-1)} Regulars`,
      ],
    };
  });
}

export const ALL: Profile[] = [...TRAINING, ...heldOut()];

// Venues for the approved cases (evals/cases/C1-C3), in each case's own words. Not part of the memory search.
const C1_TEAMS = [
  "Quizzly Bears",
  "Les Quizerables",
  "The Know-Nothings",
  "Trivia Newton-John",
];
export const CASES: Profile[] = [
  {
    // C1: week 4 at an Australian pub whose crowd finds round one easy.
    id: "case-c1",
    pub: "The Lord Nelson",
    city: "Sydney",
    region: "au",
    level: 4.6,
    skill: g(0.4, 0.4, 0, -0.2, 0, 0),
    enjoy: g(0.85, 0.9, 0.5, 0.3, 0.4, 0.45),
    enjoyFromNight3: null,
    stated: ["film", "music"],
    request: { night: 0, genre: "science", who: "nobody" },
    teams: C1_TEAMS,
    rounds: 5,
    openings: { 4: `Evening! Four teams tonight: ${C1_TEAMS.join(", ")}.` },
  },
  {
    // C2: week 2 at a pub whose crowd likes sport and history; a birthday all-music night, then an ordinary week.
    id: "case-c2",
    pub: "The Crown",
    city: "Manchester",
    region: "uk",
    level: 2.2,
    skill: g(-0.3, -0.2, 0.6, -0.4, 0.4, -0.2),
    enjoy: g(0.4, 0.35, 0.9, 0.25, 0.8, 0.45),
    enjoyFromNight3: null,
    stated: ["sport", "history"],
    request: { night: 2, genre: "music", who: "Dave" },
    teams: ["The Mancunian Candidates", "Quiz Team Aguilera", "Agatha Quiztie"],
    rounds: 5,
    openings: {
      2: "Evening! Teams tonight: The Mancunian Candidates, Quiz Team Aguilera, Agatha Quiztie. It's Dave's birthday, he's mad about music, can we do all music tonight?",
      3: "Evening! Teams tonight: The Mancunian Candidates, Quiz Team Aguilera, Agatha Quiztie.",
    },
  },
  {
    // C3: a new Manchester venue over three weeks: good on film and geography, struggles with science, enjoys film.
    id: "case-c3",
    pub: "The Old Wellington",
    city: "Manchester",
    region: "uk",
    level: 3.0,
    skill: g(0, 0.5, 0, -0.6, 0, 0.5),
    enjoy: g(0.45, 0.9, 0.45, 0.2, 0.4, 0.65),
    enjoyFromNight3: null,
    stated: [],
    request: { night: 0, genre: "science", who: "nobody" },
    teams: ["Quiz Khalifa", "The Mancunian Candidates", "Les Quizerables"],
    rounds: 5,
    openings: {
      1: "Hi! First quiz night with you. We're in Manchester. Teams: Quiz Khalifa, The Mancunian Candidates, Les Quizerables.",
      2: "Evening! Teams: Quiz Khalifa, The Mancunian Candidates, Les Quizerables.",
      3: "Evening! Teams: Quiz Khalifa, The Mancunian Candidates, Les Quizerables.",
    },
  },
];
export const byId = (id: string) => [...ALL, ...CASES].find((p) => p.id === id);

export const enjoyment = (p: Profile, genre: Genre, night: number) =>
  ((night >= 3 && p.enjoyFromNight3) || p.enjoy)[genre];

/** The chance one team answers one question right: about two in three when difficulty sits at the crowd's level for that genre. */
export function chance(
  p: Profile,
  q: { genre: Genre; region: Region; difficulty: number },
  teamIndex: number,
): number {
  if (q.region !== "global" && q.region !== p.region) return 0.03; // only another country's crowd would know it
  const eff = p.level + p.skill[q.genre] + (teamIndex - 1) * 0.3;
  return 1 / (1 + Math.exp(-(0.7 + 1.4 * (eff - q.difficulty))));
}
