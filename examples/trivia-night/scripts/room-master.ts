/**
 * The trivia master: what the room says to its host. Shared by the driver
 * that plays deployed hosts and the `host` command a host in a session uses.
 */
import type { RoomState } from "../lib/rooms";
import { teamAnswer, type Venue } from "../lib/venues";

export const TEAM_NAMES = [
  "Quizteama Aguilera",
  "The Know-It-Ales",
  "Les Quizerables",
  "Trivia Newton John",
  "Agatha Quiztie",
  "Universally Challenged",
  "The Smarty Pints",
  "Quiz Khalifa",
];

export const COUNTRY = { au: "Australia", uk: "the UK", us: "the US" } as const;

/** A request for one night only: it must not reach the venue's notes. */
export const TONIGHT_ONLY: Record<string, { week: number; ask: string }> = {
  "quiz-and-quill": {
    week: 2,
    ask: "It's a regular's birthday tonight and she's mad about music, so please make one round music, just for tonight.",
  },
};

export const TOO_HARD = [
  "That round was brutal, half the room left it blank.",
  "Way too hard, people stopped trying.",
  "Nobody had a clue on that one.",
];
export const TOO_EASY = [
  "Too easy, every table got that.",
  "Bit of a walkover, no one was stretched.",
];

export function teamsFor(venue: Venue): string[] {
  return TEAM_NAMES.slice(0, venue.teams);
}

/** What the venue says about itself: on its first night, and when asked. */
export function describe(venue: Venue): string {
  const likes = venue.likes.join(" and ");
  return `We're ${venue.name.split(",")[0]} in ${venue.name.split(", ")[1]}, ${COUNTRY[venue.region]}. The crowd here loves ${likes}.`;
}

export function opening(venue: Venue, night: number): string {
  return night === 1
    ? `Start tonight's quiz. ${describe(venue)}`
    : "Start tonight's quiz.";
}

export const ASKS_ABOUT_VENUE =
  /where (is|are) (the|this|your) (venue|pub|bar)|where are you (based|located)|which (city|country) (is|are) (the|this|your) (venue|pub|bar)|(what|which) (genres?|topics?|subjects?)[^?]*(crowd|room|regulars|venue|teams?)[^?]*(like|love|enjoy|prefer)|(crowd|room|regulars) (likes?|loves?|enjoys?|prefers?)[^?]*\?/i;

export function answerSheet(
  venue: Venue,
  state: RoomState,
  random: () => number,
): string {
  const lines = ["Here's the answer sheet for this round."];
  for (const [index, question] of state.pending.entries()) {
    lines.push("", `Question ${index + 1} (${question.id}):`);
    for (const team of state.teams) {
      const answer = teamAnswer(
        venue,
        question as Parameters<typeof teamAnswer>[1],
        random,
      );
      lines.push(`- ${team}: ${answer || "(blank)"}`);
    }
  }
  return lines.join("\n");
}
