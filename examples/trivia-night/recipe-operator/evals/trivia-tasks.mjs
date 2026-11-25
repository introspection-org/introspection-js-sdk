// What one trial of the three generic Harbor tasks (harbor/night0, night1, night2) is about,
// worked out at run time from the pub it plays: its instruction, the crowd's truth its verifier
// checks, and its bank sidecar's settings. The generator (venues.mjs), each task's check.mjs and
// the trivia-night page share it. Plain JavaScript with no imports, so the page bundles it.

export const COUNTRY = { au: "Australia", uk: "the UK", us: "the US" };
const COUNT = [
  "no",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
];
// The crowd in the room is the profile's first n teams, as the bank's crowd answers
// (EVAL_SIMULATE_TEAMS).
export const TEAM_SIZES = [3, 5, 8];
export const DEFAULT_TEAMS = 5;

/** A night's rounds and questions per round. */
export const ROUNDS = 6;
export const PER_ROUND = 4;

/**
 * @typedef {{ slug: string, label: string, profile: string, pub: string, city: string, region: "au" | "uk" | "us", teams: string[], night2_teams: Record<string, string[]>, liked: string[], disliked: string[], hinted: string[], best_decades?: string[], target_difficulty?: number }} Venue
 * @typedef {{ pub: string, night: 0 | 1 | 2, teams: number }} Trial
 */

export const list = (items) =>
  items.length > 1
    ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`
    : (items[0] ?? "");

/**
 * The notes a host would leave had it learned everything night 1's crowd could
 * show: the venue's true country, favourites, least favourite genre, starting
 * level and best decades, in a host's style, about the crowd and never a team.
 * Night 0 seeds them for the "perfect notes" night 2.
 * @param {Venue} venue
 */
export function perfectNotes(venue) {
  const level = venue.target_difficulty ?? 3;
  return [
    "# Venue notes",
    "",
    `- Country: ${COUNTRY[venue.region].replace(/^the /, "")} (${venue.city}). Use region \`${venue.region}\` (or \`global\`).`,
    `- Genres: the crowd loves ${list(venue.liked)}. Plan about 4 of ${ROUNDS} rounds on those and keep the other genres in rotation.`,
    ...(venue.disliked.length
      ? [
          `- They don't enjoy ${list(venue.disliked).replace(/ and /, " or ")}: keep ${venue.disliked.length === 1 ? "it" : "those"} rare.`,
        ]
      : []),
    `- Difficulty: start next night at ${level}. Aim for about two in three right and adjust from round_summary.`,
    ...(venue.best_decades?.length
      ? [`- Eras: the crowd knows the ${list(venue.best_decades)} best.`]
      : []),
    "",
  ].join("\n");
}

/** Night 1's crowd and night 2's, for a crowd of `size`. */
function crowds(venue, size) {
  const crowd = venue.teams.slice(0, size);
  const later = venue.night2_teams?.[String(size)] ?? crowd;
  return { crowd, later };
}

/**
 * The truth a night's verifier checks: the crowd's tastes and the teams in the
 * room, as night 1's crowd shows them for both nights, since notes are graded on
 * what a host could have learned.
 * @param {Venue} venue @param {1 | 2} night @param {number} [size]
 */
export function expectedFor(venue, night, size = DEFAULT_TEAMS) {
  const { crowd, later } = crowds(venue, size);
  return {
    venue: venue.profile,
    region: venue.region,
    teams: night === 2 ? later : crowd,
    ...(night === 2 ? { night1_teams: crowd } : {}),
    liked: venue.liked,
    disliked: venue.disliked,
    hinted: venue.hinted,
    ...(venue.best_decades ? { best_decades: venue.best_decades } : {}),
    ...(venue.target_difficulty === undefined
      ? {}
      : { target_difficulty: venue.target_difficulty }),
  };
}

/**
 * What the trivia master tells the host for a night.
 * @param {Venue} venue @param {0 | 1 | 2} night @param {number} [size]
 */
export function instructionFor(venue, night, size = DEFAULT_TEAMS) {
  if (night === 0)
    return `Before next week's night here in ${venue.city}, the trivia master has written up notes on the venue for you to keep. There's no quiz tonight, so don't start a night or fetch any questions: just replace memories/MEMORY.md with exactly the notes between the lines below, word for word, and nothing else.\n\n---\n\n${perfectNotes(venue)}\n---\n`;
  const { crowd, later } = crowds(venue, size);
  const back = later.filter((t) => crowd.includes(t));
  const fresh = later.filter((t) => !crowd.includes(t));
  const teams = list(crowd);
  const count = COUNT[crowd.length] ?? String(crowd.length);
  const Count = count[0].toUpperCase() + count.slice(1);
  const Later = (COUNT[later.length] ?? String(later.length)).replace(
    /^./,
    (c) => c.toUpperCase(),
  );
  const rounds = `The bank records the crowd's answers as you serve each round, so you won't get a sheet back: after each round, check round_summary to see how they did. I won't reply until the night is over, so run all six rounds straight through in this one go without waiting for me.`;
  if (night === 1) {
    // Only one favourite is hinted: the host learns the rest, and the level, from round_summary.
    const loved = venue.hinted.length
      ? ` From what I've seen, this crowd loves ${list(venue.hinted)}.`
      : "";
    return `We're in ${venue.city}, in ${COUNTRY[venue.region]}, and it's our first trivia night with you. ${Count} teams tonight: ${teams}.${loved} We've time for six short rounds of four questions: plan the night, fetch each round and read it out. ${rounds} After the sixth round that's the end of tonight: leave your notes ready for next week, as you would after the last round.\n`;
  }
  const night2Teams = fresh.length
    ? `${Later} teams tonight here in ${venue.city}: ${list(later)}. ${list(back)} ${back.length === 1 ? "was" : "were"} here last week; ${list(fresh)} ${fresh.length === 1 ? "is" : "are"} new.`
    : `Same ${count} teams as last week here in ${venue.city}: ${teams}.`;
  return `Evening! ${night2Teams} Six short rounds of four again tonight: plan them, fetch each round and read it out. ${rounds} After the sixth round we're done, so leave your notes ready for next week.\n`;
}

/**
 * The bank sidecar's settings for a night: each night runs in its own sandbox
 * from a fresh bank, and EVAL_SIMULATE_NIGHT gives it that night's share of the
 * venue's questions, split across the series' two nights. Night 0 serves none.
 * @param {Venue} venue @param {0 | 1 | 2} night @param {number} [size]
 */
export function bankEnvironment(venue, night, size = DEFAULT_TEAMS) {
  return {
    EVAL_SIMULATE_SCENARIO: `crowd-${venue.profile}`,
    EVAL_SIMULATE_NIGHT: String(night === 0 ? 1 : night),
    EVAL_SIMULATE_SERIES_NIGHTS: "2",
    EVAL_SIMULATE_TEAMS: String(night === 0 ? DEFAULT_TEAMS : size),
    EVAL_SIMULATE_MANIFEST_DIR: "/verifier",
  };
}

/** The bank sidecar's compose service name, which is also the host the agent reaches it on. */
export const BANK_SERVICE = "fakes";

/**
 * A trial's compose world for a night, with the bank built from `context`: a
 * path beside the task for a local Harbor run, or the platform's Files API id
 * of the same folder's archive. The bank's verifier manifest reaches the
 * verifier on `fakes-verifier`.
 * @param {Venue} venue @param {0 | 1 | 2} night @param {number} size @param {string} context
 */
export function trialWorld(venue, night, size, context) {
  return {
    services: {
      main: {
        depends_on: { [BANK_SERVICE]: { condition: "service_healthy" } },
        volumes: ["fakes-verifier:/opt/fakes-verifier:ro"],
      },
      [BANK_SERVICE]: {
        build: { context },
        environment: bankEnvironment(venue, night, size),
        volumes: ["fakes-verifier:/verifier"],
        healthcheck: {
          test: [
            "CMD",
            "node",
            "-e",
            "fetch('http://127.0.0.1:7353/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))",
          ],
          interval: "1s",
          retries: 30,
        },
      },
    },
    volumes: { "fakes-verifier": {} },
  };
}

/**
 * The trial a verifier scores: from the task's metadata (`trivia_night.trial`,
 * which the platform passes as INTROSPECTION_TASK_METADATA_JSON), else from
 * TRIVIA_PUB, TRIVIA_NIGHT and TRIVIA_TEAMS, which a plain Harbor run sets.
 * @param {Record<string, string | undefined>} env
 * @returns {Trial}
 */
export function trialOf(env) {
  const metadata = env.INTROSPECTION_TASK_METADATA_JSON
    ? JSON.parse(env.INTROSPECTION_TASK_METADATA_JSON)
    : {};
  const trial = metadata?.trivia_night?.trial ?? {
    pub: env.TRIVIA_PUB,
    night: Number(env.TRIVIA_NIGHT),
    teams: Number(env.TRIVIA_TEAMS || DEFAULT_TEAMS),
  };
  if (!trial.pub || ![0, 1, 2].includes(trial.night))
    throw new Error(
      "no trial: set metadata.trivia_night.trial, or TRIVIA_PUB and TRIVIA_NIGHT",
    );
  return {
    pub: trial.pub,
    night: trial.night,
    teams: trial.teams ?? DEFAULT_TEAMS,
  };
}

/**
 * The pub a trial plays, from the development and held-out venue lists.
 * @param {Venue[][]} lists @param {string} pub
 */
export function venueNamed(lists, pub) {
  const venue = lists.flat().find((v) => v.slug === pub);
  if (!venue) throw new Error(`no pub ${pub} in venues.json or heldout.json`);
  return venue;
}
