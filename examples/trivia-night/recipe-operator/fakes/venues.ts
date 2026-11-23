// The world of the memory search: each venue's crowd, and how a room answers.
// Profiles are data; training and held-out venues are rows, never branches.
// Agreed with the owner on 2026-11-22 (runs/improve-memory/<id>/brief.md).
import { randomOf } from "@introspection-ai/eval-simulate/mcp";
import { GENRES, type Region, wrongOf } from "./scenarios/bank.ts";
import type { Question } from "./mcp/question-bank/entities.ts";

export type Venue = {
  id: string;
  name: string;
  region: Exclude<Region, "general">;
  /** The level at which the room gets about two in three right, on night 1. */
  skill: number;
  /** How much sharper the crowd gets each week (0 for most venues). */
  drift: number;
  liked: string[];
  disliked: string[];
  /** What the trivia master says the crowd likes on night 1: only mostly right. */
  stated: string[];
  /** The night a one-night request is made, and what it asks for. */
  request: { night: number; genre: string; text: string } | null;
  teams: { name: string; offset: number }[];
  kind: string;
};

export const NIGHTS = 3;
export const ROUNDS = 3;
export const PER_ROUND = 10;

/** Room response: logistic in (skill tonight + team offset - level), shifted by taste. */
export const SLOPE = 1.2;
export const BASE = 0.69; // at level == skill, a neutral genre lands at about 2 in 3
export const LIKED = 0.4;
export const DISLIKED = -0.7;
export const FOREIGN_P = 0.1;

export const skillOn = (v: Venue, night: number) =>
  v.skill + v.drift * (night - 1);

export function pCorrect(
  v: Venue,
  night: number,
  teamOffset: number,
  q: Question,
): number {
  if (q.region !== "general" && q.region !== v.region) return FOREIGN_P;
  const taste = v.liked.includes(q.genre)
    ? LIKED
    : v.disliked.includes(q.genre)
      ? DISLIKED
      : 0;
  const x =
    SLOPE * (skillOn(v, night) + teamOffset - q.difficulty) + BASE + taste;
  return 1 / (1 + Math.exp(-x));
}

/** One team's typed answer to one question: pure and seeded, keyed by what the call holds. */
export function teamAnswer(
  seed: number,
  v: Venue,
  night: number,
  team: { name: string; offset: number },
  q: Question,
) {
  const random = randomOf(seed, v.id, night, team.name, q.id);
  const right = random() < pCorrect(v, night, team.offset, q);
  if (right) return { right, text: q.answer };
  return { right, text: random() < 0.3 ? "(blank)" : wrongOf(q.id, team.name) };
}

const TEAM_NAMES = [
  "Quizteama Aguilera",
  "The Quizzly Bears",
  "Les Quizerables",
  "Agatha Quiztie",
  "Universally Challenged",
  "Quiz Khalifa",
  "The Smarty Pints",
  "Tequila Mockingbird",
  "Trivia Newton John",
  "Sherlock Foams",
  "The Brew Crew",
  "Quizzy Rascal",
  "E=MC Hammered",
  "The Trivia Tigers",
  "Beer Necessities",
  "Norfolk Enchants",
  "The Pun Intended",
  "Hoppy Gilmore",
];
const teamsFrom = (start: number, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    name: TEAM_NAMES[(start + i) % TEAM_NAMES.length],
    offset: Number(((i / (n - 1)) * 1.2 - 0.6).toFixed(2)),
  }));

export const TRAINING: Venue[] = [
  {
    id: "t1-uk",
    name: "The Crown and Anchor",
    region: "UK",
    skill: 3.6,
    drift: 0,
    liked: ["film", "music", "history"],
    disliked: ["sport", "science"],
    stated: ["film", "history", "tv"],
    request: null,
    teams: teamsFrom(0, 6),
    kind: "regular",
  },
  {
    id: "t2-au",
    name: "The Coogee Bowls Club",
    region: "AU",
    skill: 2.3,
    drift: 0,
    liked: ["sport", "tv", "food-and-drink"],
    disliked: ["literature", "history"],
    stated: ["sport", "tv", "geography"],
    request: {
      night: 2,
      genre: "music",
      text: "We've got a birthday in tonight, and the birthday girl has asked for one music round, just for tonight.",
    },
    teams: teamsFrom(6, 7),
    kind: "one-night request",
  },
  {
    id: "t3-us",
    name: "Murphy's Tap Room",
    region: "US",
    skill: 2.9,
    drift: 0.5,
    liked: ["sport", "film", "science"],
    disliked: ["christmas", "literature"],
    stated: ["sport", "film", "music"],
    request: null,
    teams: teamsFrom(12, 6),
    kind: "crowd getting sharper",
  },
];

/**
 * Held-out venues, sampled once with a fixed seed over the training ranges and
 * committed before any candidate runs. Each differs in kind from training.
 */
export const HELD_OUT_SEED = 20261122;
export function sampleVenues(seed: number, n: number): Venue[] {
  const kinds = [
    "narrow tastes",
    "crowd getting sharper",
    "trivia master misjudges the crowd",
  ];
  const regions: Venue["region"][] = ["UK", "AU", "US"];
  const out: Venue[] = [];
  for (let i = 0; i < n; i++) {
    const r = randomOf(seed, "venue", i);
    const kind = kinds[i % kinds.length];
    const pool = [...GENRES].filter((g) => g !== "christmas");
    const pick = () => pool.splice(Math.floor(r() * pool.length), 1)[0];
    const nLiked = kind === "narrow tastes" ? 1 : 3;
    const nDisliked = kind === "narrow tastes" ? 4 : 2;
    const liked = Array.from({ length: nLiked }, pick);
    const disliked = Array.from({ length: nDisliked }, pick);
    const neutral = [...pool];
    const stated =
      kind === "trivia master misjudges the crowd"
        ? [liked[0], neutral[0], neutral[1]]
        : kind === "narrow tastes"
          ? [liked[0], neutral[0]]
          : [liked[0], liked[1], neutral[0]];
    out.push({
      id: `h${i + 1}-${regions[i % 3].toLowerCase()}`,
      name: `Held-out venue ${i + 1}`,
      region: regions[i % 3],
      skill: Number((1.8 + r() * 2.6).toFixed(1)),
      drift: kind === "crowd getting sharper" ? 0.5 : 0,
      liked,
      disliked,
      stated,
      request: null,
      teams: teamsFrom(
        Math.floor(r() * TEAM_NAMES.length),
        5 + Math.floor(r() * 4),
      ),
      kind,
    });
  }
  return out;
}
export const HELD_OUT: Venue[] = sampleVenues(HELD_OUT_SEED, 6);
export const VENUES: Venue[] = [...TRAINING, ...HELD_OUT];
