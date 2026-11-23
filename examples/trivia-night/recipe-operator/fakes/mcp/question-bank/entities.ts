export type Question = {
  id: string;
  genre: string;
  region: "general" | "AU" | "UK" | "US";
  difficulty: number;
  text: string;
  answer: string;
};

/** A scored round: the bank keeps the facts (what was asked, how each question went). */
export type Round = {
  id: string;
  question_ids: string[];
  teams: { team: string; score: number; out_of: number }[];
  correct_per_question: number[];
};

export type State = {
  /** How many questions each cell (`genre|region|level`) holds; question k of a cell is derived from its id. */
  supply: Record<string, number>;
  /** Ids of questions scored at this venue: never listed again. */
  asked: string[];
  rounds: Round[];
};
