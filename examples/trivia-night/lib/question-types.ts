/**
 * The question bank's contents. Difficulty runs 1 (most rooms get it) to 5
 * (few do). A region other than `global` marks a question a local crowd finds
 * easier and anyone else finds unfair.
 */
export type Genre =
  "music" | "film" | "sport" | "science" | "history" | "geography";
export type Region = "global" | "au" | "uk" | "us";

export interface Question {
  id: string;
  genre: Genre;
  region: Region;
  difficulty: 1 | 2 | 3 | 4 | 5;
  text: string;
  answer: string;
  /** Other spellings and short forms a host would accept. */
  aliases: string[];
}

export const GENRES: Genre[] = [
  "music",
  "film",
  "sport",
  "science",
  "history",
  "geography",
];

export const q = (
  id: string,
  genre: Genre,
  region: Region,
  difficulty: Question["difficulty"],
  text: string,
  answer: string,
  aliases: string[] = [],
): Question => ({ id, genre, region, difficulty, text, answer, aliases });
