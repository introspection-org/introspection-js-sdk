// The venues a memory search plays, and the platform evals' venues, as data. Every venue's
// crowd is people (crowd.ts): eight teams drawn from its country's demographic mix. The memory
// search's venues set their level, skill and tastes by hand, and their crowd is shifted to meet
// that level; the platform evals' venues (PAGE, HELDOUT) derive level and tastes from the crowd.
import { randomOf } from "@introspection-ai/eval-simulate/mcp";
import type { Genre, Region } from "../mcp/trivia-bank/entities.ts";
import {
  DECADES,
  GENRES,
  crowdInterest,
  expected,
  ranked,
  sampleCrowd,
  sampleNewcomers,
  teamChance,
  type Asked,
  type Team,
} from "./crowd.ts";
import { HELDOUT_PUBS } from "./heldout.ts";
import { MAX_DRAWS, STEREOTYPES } from "./stereotypes.ts";

export { GENRES };

/** The crowd sizes a platform eval can play, and the one it plays when none is named. */
export const CROWD_SIZES = [3, 5, 8] as const;
export const DEFAULT_CROWD = 5;

/** What a venue is before its crowd says what it likes: a pub, its city, its teams. */
export type VenueBase = {
  id: string;
  pub: string;
  city: string;
  region: Exclude<Region, "global">; // the venue's own country
  request: { night: number; genre: Genre; who: string }; // a request for that night only
  teams: string[];
};

export type Profile = {
  id: string;
  pub: string;
  city: string;
  region: Exclude<Region, "global">; // the venue's own country
  // Set by hand: the difficulty an average team answers about two in three right on an average genre.
  // Derived: the difficulty the default crowd answers 65% right on its two favourite genres.
  level: number;
  skill?: Record<Genre, number>; // set by hand only: per-genre offset to level (-1..+1)
  enjoy: Record<Genre, number>; // how much the crowd enjoys a genre (0..1); derived: its members' mean interest
  enjoyFromNight3: Record<Genre, number> | null; // a crowd whose taste changes from night 3
  stated: Genre[]; // what the trivia master says on night 1 that the crowd likes (mostly, not always, what it enjoys)
  request: { night: number; genre: Genre; who: string }; // a request for that night only
  teams: string[];
  openings?: Record<number, string>; // the trivia master's exact opening on a given night (an approved case's words)
  rounds?: number; // rounds the trivia master runs tonight before calling time (default 3, as the memory search agreed)
  decades?: string[]; // derived only: the two decades the default crowd knows best
  draw?: number; // derived only: which draw of the crowd was kept (the stereotype rule)
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
    teams: [
      "Quizzly Bears",
      "Les Quizerables",
      "Trivia Newton-John",
      "The Bondi Brainstormers",
      "Opera House Party",
      "Manly Know-It-Alls",
      "The Harbour Bridge Players",
      "Surry Hills Have Eyes",
    ],
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
    teams: [
      "The Mancunian Candidates",
      "Quiz Team Aguilera",
      "Agatha Quiztie",
      "Oasis of Knowledge",
      "Quiz Division",
      "Corrie Street Smarts",
      "The Ancoats Answerers",
      "Mancunian Way Out",
    ],
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
    teams: [
      "Smarty Pints",
      "The Quizzards",
      "Universally Challenged",
      "Deep Dish Thinkers",
      "The Windy City Wits",
      "The Second City Sages",
      "Wrigley Field Goals",
      "The Loop Hole",
    ],
  },
];

// Each held-out pub with five local teams of its own, after the three every held-out venue has.
const PUBS: [string, string, Profile["region"], string[]][] = [
  [
    "The Royal Oak",
    "Leeds",
    "uk",
    [
      "Yorkshire Puddingheads",
      "The Headingley Hopefuls",
      "Elland Road Scholars",
      "The Briggate Brainboxes",
      "Kirkstall Abbey Roads",
    ],
  ],
  [
    "The Esplanade",
    "Melbourne",
    "au",
    [
      "Flat White Thinkers",
      "The Laneway Legends",
      "Tram Stop Trivia",
      "The St Kilda Sharks",
      "Footscray Fact Finders",
    ],
  ],
  [
    "Murphy's",
    "Boston",
    "us",
    [
      "Fenway Fact Checkers",
      "The Chowdaheads",
      "Wicked Smaht",
      "The Beacon Hill Brains",
      "Back Bay Buzzers",
    ],
  ],
  [
    "The Swan",
    "Bristol",
    "uk",
    [
      "Banksy's Bright Sparks",
      "The Clifton Suspenders",
      "The Harbourside Heroes",
      "Brizzle Brainboxes",
      "The Gromit Unit",
    ],
  ],
  [
    "The Grand",
    "Brisbane",
    "au",
    [
      "Bris-Vegas Brainstrust",
      "The Story Bridge Club",
      "The South Bank Thinkers",
      "Lamington Legends",
      "The Gabba Grey Matter",
    ],
  ],
  [
    "Dockside",
    "Seattle",
    "us",
    [
      "The Space Needlers",
      "Grunge Against the Machine",
      "Pike Place Fishmongers",
      "The Rainy Day Ravers",
      "Sleepless in Quizattle",
    ],
  ],
  [
    "The Anchor",
    "Glasgow",
    "uk",
    [
      "Irn-Bru Brains",
      "Weegie Wonders",
      "The Clydeside Thinkers",
      "Barrowland Ballers",
      "The Kelvingrove Knowers",
    ],
  ],
  [
    "The Railway",
    "Perth",
    "au",
    [
      "Quokka Quizzers",
      "The Fremantle Doctors",
      "The Cottesloe Crew",
      "Swan River Scholars",
      "Kings Park Rangers",
    ],
  ],
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
  return PUBS.map(([pub, city, region, local], i) => {
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
        ...local,
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
// The platform evals' venues: the memory search's pubs and teams, with a crowd of their own whose
// tastes, level and best decades are read off its members, never set.
const pageBase = (p: Profile): VenueBase => ({
  id: `page-${p.city.toLowerCase()}`,
  pub: p.pub,
  city: p.city,
  region: p.region,
  request: p.request,
  teams: p.teams,
});

/** A venue's regulars: the crowd for the profile's draw. */
const regularsOf = (base: VenueBase, draw: number) =>
  sampleCrowd(base.id, base.region, base.teams, draw);

const overlap = (teams: Team[], city: string) => {
  const top = ranked(crowdInterest(teams)).slice(0, 2);
  return top.filter((g) => (STEREOTYPES[city] ?? []).includes(g)).length;
};

/**
 * Which draw of a venue's crowd it keeps: the first whose two favourites miss its city's
 * stereotype, else after MAX_DRAWS the first with the least overlap.
 */
export function drawOf(base: VenueBase): number {
  let best = 0;
  let least = Infinity;
  for (let draw = 0; draw < MAX_DRAWS; draw++) {
    const n = overlap(regularsOf(base, draw), base.city);
    if (n === 0) return draw;
    if (n < least) [best, least] = [draw, n];
  }
  return best;
}

/** How many of the first draw's favourites match the city's stereotype (0-2): before the rule. */
export const firstDrawOverlap = (base: VenueBase) =>
  overlap(regularsOf(base, 0), base.city);

/** The difficulty at which `teams` get `target` right on `genres`, between 1 and 5. */
function levelFor(
  teams: Team[],
  genres: Genre[],
  region: Region,
  target: number,
  shift = 0,
) {
  let [lo, hi] = [0, 6];
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    if (expected(teams, genres, mid, region, { shift }) > target) lo = mid;
    else hi = mid;
  }
  return Math.min(5, Math.max(1, Math.round(((lo + hi) / 2) * 10) / 10));
}

/** A platform-eval venue: tastes, level and best decades read off its crowd. */
export function derive(base: VenueBase): Profile {
  const draw = drawOf(base);
  const regulars = regularsOf(base, draw);
  const enjoy = crowdInterest(regulars);
  const favourites = ranked(enjoy).slice(0, 2);
  const tonight = regulars.slice(0, DEFAULT_CROWD);
  const decades = [...DECADES]
    .map((decade) => ({
      decade,
      rate: expected(tonight, GENRES, 3, base.region, { decades: [decade] }),
    }))
    .sort((a, b) => b.rate - a.rate)
    .slice(0, 2)
    .map((d) => d.decade);
  return {
    ...base,
    level: levelFor(tonight, favourites, base.region, 0.65),
    enjoy,
    enjoyFromNight3: null,
    // The trivia master names only the favourite; the second is for the host to find.
    stated: favourites.slice(0, 1),
    decades,
    draw,
  };
}

export const PAGE: Profile[] = ALL.map((p) => derive(pageBase(p)));

/** The page's held-out pubs (evals/heldout.mjs), kept out of development. */
export const HELDOUT: Profile[] = HELDOUT_PUBS.map(derive);

export const byId = (id: string) =>
  [...ALL, ...CASES, ...PAGE, ...HELDOUT].find((p) => p.id === id);

export const enjoyment = (p: Profile, genre: Genre, night: number) =>
  ((night >= 3 && p.enjoyFromNight3) || p.enjoy)[genre];

// Names for the teams that are new on night 2; a venue never takes one its regulars use.
const NEWCOMER_NAMES = [
  "The Late Arrivals",
  "Fresh Faces",
  "The Blow-Ins",
  "First Timers",
  "The Walk-Ins",
  "New Kids on the Quiz",
  "The Plus Ones",
  "Beginners' Luck",
];
/** The most teams new on any night: a crowd of 8 keeps at least 6. */
const MAX_NEW = 2;

/** Night 2's returning share: about four in five (5 teams keep 4; 3 keep 2 or 3; 8 keep 6 or 7). */
export function returningCount(p: Profile, n: number): number {
  const r = randomOf(0, "turnover", p.id, n);
  if (n === 5) return 4;
  if (n === 3) return r() < 0.5 ? 2 : 3;
  if (n === 8) return r() < 0.5 ? 6 : 7;
  return Math.round(n * 0.8);
}

/** The night-1 teams of a crowd of n who come back on night 2, in their night-1 order. */
export function returning(p: Profile, n: number = DEFAULT_CROWD): string[] {
  const first = p.teams.slice(0, n);
  const keep = returningCount(p, n);
  const r = randomOf(0, "turnover", p.id, n, "who");
  const order = first
    .map((team) => ({ team, key: r() }))
    .sort((a, b) => a.key - b.key)
    .slice(0, keep)
    .map((x) => x.team);
  return first.filter((team) => order.includes(team));
}

/** The names a venue's new teams take, in the order they arrive. */
export function newcomerNames(p: Profile): string[] {
  const r = randomOf(0, "newcomer-names", p.id);
  return NEWCOMER_NAMES.filter((name) => !p.teams.includes(name))
    .map((name) => ({ name, key: r() }))
    .sort((a, b) => a.key - b.key)
    .slice(0, MAX_NEW)
    .map((x) => x.name);
}

/**
 * The teams in the room for a crowd of n on a night of a platform-eval series: night 1 is the
 * profile's first n; from night 2 about four in five of them return and new teams fill the rest.
 * With no series night (a memory search's bank), the same first n every night.
 */
export function crowd(
  p: Profile,
  n: number = DEFAULT_CROWD,
  night?: number,
): string[] {
  if (!night || night < 2) return p.teams.slice(0, n);
  const back = returning(p, n);
  return [...back, ...newcomerNames(p).slice(0, n - back.length)];
}

type Seated = { teams: Map<string, Team>; shift: number };
const seated = new Map<string, Seated>();

/** A venue's teams by name (regulars and newcomers), and the shift a hand-set venue's crowd takes. */
function seatsOf(p: Profile): Seated {
  const known = seated.get(p.id);
  if (known) return known;
  const regulars = sampleCrowd(p.id, p.region, p.teams, p.draw ?? 0);
  const newcomers = sampleNewcomers(
    p.id,
    p.region,
    newcomerNames(p),
    p.draw ?? 0,
  );
  const teams = new Map(
    [...regulars, ...newcomers].map((t) => [t.name, t] as const),
  );
  // A hand-set venue's crowd is moved as a whole so an average team meets its level.
  let shift = 0;
  if (p.skill) {
    let [lo, hi] = [-12, 12];
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (expected(regulars, GENRES, p.level, p.region, { shift: mid }) < 2 / 3)
        lo = mid;
      else hi = mid;
    }
    shift = (lo + hi) / 2;
  }
  const out = { teams, shift };
  seated.set(p.id, out);
  return out;
}

/** A venue's team by name or by its place among the regulars; a name it doesn't know plays as its first team. */
export function teamOf(p: Profile, team: string | number): Team {
  const { teams } = seatsOf(p);
  const name = typeof team === "number" ? p.teams[team] : team;
  return (
    (name === undefined ? undefined : teams.get(name)) ??
    (teams.get(p.teams[0]) as Team)
  );
}

/** The chance one team answers one question right, from its members (crowd.ts). */
export function chance(
  p: Profile,
  q: Omit<Asked, "difficulty"> & { difficulty: number },
  team: string | number,
): number {
  const { shift } = seatsOf(p);
  const difficulty = q.difficulty - (p.skill?.[q.genre] ?? 0);
  return teamChance(teamOf(p, team), { ...q, difficulty }, p.region, shift);
}

/**
 * Whether a team answers a question right: drawn from the venue's crowd, keyed
 * only by the seed, venue, question and team, so the same team answers the same
 * question the same way on every night and in every run.
 */
export function answersRight(
  p: Profile,
  q: { id: string } & Asked,
  team: string,
  seed = 0,
): boolean {
  return randomOf(seed, p.id, q.id, team)() < chance(p, q, team);
}
