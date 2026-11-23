/**
 * What the room driver reads about one venue: the questions served and not yet
 * answered, each submitted round with its marks, and tonight's standings. The
 * driver plays the room from it; the agent never sees it.
 */
import { askedRecords, reset, week } from "./bank";
import { QUESTIONS } from "./questions";
import { resetScores, scoresOf } from "./scorer";

export interface RoomRound {
  week: number;
  question_ids: string[];
  genres: string[];
  regions: string[];
  difficulties: number[];
  answers: number;
  correct: number;
  blanks: number;
}

export interface RoomState {
  owner: string;
  week: number;
  teams: string[];
  standings: { team: string; points: number }[];
  /** Served this week and not yet in a submitted round. */
  pending: { id: string; genre: string; region: string; difficulty: number }[];
  rounds: RoomRound[];
}

export function roomState(owner: string): RoomState {
  const asked = askedRecords(owner);
  const byId = new Map(asked.map((item) => [item.question_id, item]));
  const { tonight, rounds } = scoresOf(owner);
  const now = week(owner);
  const submitted = new Set(rounds.flatMap((round) => round.ids));
  const question = (id: string) => QUESTIONS.find((item) => item.id === id)!;
  return {
    owner,
    week: now,
    teams: tonight.week === now ? tonight.teams : [],
    standings: tonight.week === now ? tonight.standings : [],
    pending: asked
      .filter((item) => item.week === now && !submitted.has(item.question_id))
      .map((item) => ({
        id: item.question_id,
        genre: item.genre,
        region: question(item.question_id).region,
        difficulty: item.difficulty,
      })),
    rounds: rounds.map((round) => {
      const items = round.ids.map((id) => byId.get(id)!);
      return {
        week: round.week,
        question_ids: round.ids,
        genres: items.map((item) => item.genre),
        regions: round.ids.map((id) => question(id).region),
        difficulties: items.map((item) => item.difficulty),
        answers: items.reduce((sum, item) => sum + item.answers, 0),
        correct: items.reduce((sum, item) => sum + item.correct, 0),
        blanks: items.reduce((sum, item) => sum + item.blanks, 0),
      };
    }),
  };
}

export function resetRoom(owner: string): void {
  reset(owner);
  resetScores(owner);
}
