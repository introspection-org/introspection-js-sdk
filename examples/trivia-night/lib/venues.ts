/**
 * Simulated venues. Each is a table of how well its crowd knows each genre,
 * so a night can be played and scored with no model and the same result every
 * run. A venue's own region is easier for it; another venue's is unfair.
 */
import { QUESTIONS, type Genre, type Question, type Region } from "./questions";

export interface Venue {
  id: string;
  name: string;
  region: Exclude<Region, "global">;
  teams: number;
  /** Chance a team gets a mid-difficulty question in this genre right. */
  skill: Record<Genre, number>;
  /** What the venue tells its host on the first night. */
  likes: Genre[];
  /** Not seen by anyone tuning the host; scored separately. */
  heldOut: boolean;
}

const skill = (base: number, strong: Partial<Record<Genre, number>>) => ({
  music: base,
  film: base,
  sport: base,
  science: base,
  history: base,
  geography: base,
  ...strong,
});

export const VENUES: Venue[] = [
  {
    id: "the-anchor",
    name: "The Anchor, Melbourne",
    region: "au",
    teams: 6,
    skill: skill(0.45, { sport: 0.85, music: 0.7 }),
    likes: ["sport", "music"],
    heldOut: false,
  },
  {
    id: "quiz-and-quill",
    name: "The Quiz & Quill, Oxford",
    region: "uk",
    teams: 5,
    skill: skill(0.6, { science: 0.9, history: 0.85, sport: 0.3 }),
    likes: ["science", "history"],
    heldOut: false,
  },
  {
    id: "campus-bar",
    name: "Campus Bar, Austin",
    region: "us",
    teams: 8,
    skill: skill(0.35, { film: 0.7, music: 0.65 }),
    likes: ["film", "music"],
    heldOut: false,
  },
  {
    id: "old-regulars",
    name: "The Old Regulars, Sydney",
    region: "au",
    teams: 4,
    skill: skill(0.85, { geography: 0.95 }),
    likes: ["geography", "history"],
    heldOut: true,
  },
  {
    id: "first-timers",
    name: "First Timers, Leeds",
    region: "uk",
    teams: 7,
    skill: skill(0.3, { film: 0.5 }),
    likes: ["film"],
    heldOut: true,
  },
];

/** A small seeded generator, so a simulation repeats exactly. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chanceRight(venue: Venue, question: Served): number {
  const local =
    question.region === "global"
      ? 0
      : question.region === venue.region
        ? 0.15
        : -0.3;
  const chance =
    venue.skill[question.genre] + 0.12 * (3 - question.difficulty) + local;
  return Math.min(0.97, Math.max(0.03, chance));
}

type Served = Pick<Question, "id" | "genre" | "region" | "difficulty">;

function misspell(word: string, random: () => number): string {
  if (word.length < 6 || /\d/.test(word)) return word;
  const at = 1 + Math.floor(random() * (word.length - 2));
  return word.slice(0, at) + word[at + 1] + word[at] + word.slice(at + 2);
}

/** What one team says: right (sometimes loosely worded or misspelt) or wrong. */
export function teamAnswer(
  venue: Venue,
  served: Served,
  random: () => number,
): string {
  const question = QUESTIONS.find((item) => item.id === served.id)!;
  if (random() < chanceRight(venue, served)) {
    const forms = [question.answer, ...question.aliases];
    const form = forms[Math.floor(random() * forms.length)];
    return random() < 0.1 ? misspell(form, random) : form;
  }
  const others = QUESTIONS.filter(
    (item) => item.genre === question.genre && item.answer !== question.answer,
  );
  // A team with no idea hands in a blank.
  return random() < 0.3
    ? ""
    : others[Math.floor(random() * others.length)].answer;
}
