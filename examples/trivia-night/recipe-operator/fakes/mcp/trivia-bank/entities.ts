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
  format: "choice" | "short";
  text: string;
  options?: string[]; // a choice question's four options, the answer among them
  answer: string;
  decade?: string; // the decade a real question is about; placeholders have none
};

export type Night = { week: number; teams: string[] };

// A question the bank gave this venue, in the week and the request it was given in,
// with its genre, region and difficulty so a verifier can read the round from the state.
export type Asked = {
  question_id: string;
  week: number;
  request: number;
  genre?: Genre;
  region?: Region;
  difficulty?: number;
};

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
  // In a memory search, the venue profile the world marks answers by (see world/);
  // null marks a typed answer against the question's answer.
  venue: string | null;
  // The crowd answers on its own: every question served is marked at once for the
  // venue profile's first crowd_size teams (5 when unset), and round_summary reports each round's marks.
  crowd?: boolean;
  crowd_size?: number;
  // The night of the series this sandbox plays, when each night runs in its own sandbox from a fresh
  // bank: the bank then serves only that night's share of the venue's questions (supply.ts), so two
  // nights at one venue never share a question. Unset, every question is in play.
  series_night?: number;
  // The nights the series splits the venue's questions across; SERIES_NIGHTS when unset.
  series_nights?: number;
  nights: Night[]; // the last one is tonight's, once start_night was called
  asked: Asked[];
  marks: Mark[];
};
