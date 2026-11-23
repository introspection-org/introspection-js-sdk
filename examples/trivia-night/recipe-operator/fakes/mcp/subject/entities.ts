import type { Venue } from "../../venues.ts";

export type HeardRound = {
  question_ids: string[];
  /** Per question, how many teams got it right. */
  correct: number[];
  teams: number;
};

export type Night = { night: number; rounds: HeardRound[]; ended: boolean };

export type State = {
  seed: number;
  venue: Venue | null;
  nights: Night[];
};
