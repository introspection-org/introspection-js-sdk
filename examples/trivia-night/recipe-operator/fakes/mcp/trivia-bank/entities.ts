// What the trivia bank stores for one venue. The real bank tells venues apart by
// the platform's end-user token; a fake's world is one venue.

export type Genre =
  "music" | "film" | "sport" | "science" | "history" | "geography";
export type Region = "global" | "au" | "uk" | "us";

export type Question = {
  id: string;
  genre: Genre;
  region: Region;
  difficulty: number; // 1 easiest to 5 hardest
  text: string;
  answer: string;
};

export type Night = { week: number; teams: string[] };

// A question the bank gave this venue, in the week it was given.
export type Asked = { question_id: string; week: number };

// One team's marked answer to one question.
export type Mark = {
  week: number;
  question_id: string;
  team: string;
  answer: string;
  correct: boolean;
};

export type State = {
  seed: number;
  questions: Question[];
  nights: Night[]; // the last one is tonight's, once start_night was called
  asked: Asked[];
  marks: Mark[];
};
