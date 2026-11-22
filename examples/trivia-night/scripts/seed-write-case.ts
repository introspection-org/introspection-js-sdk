/**
 * The bank's state for the write case: Quiz & Quill has just played week 1,
 * a science round that was too easy, a history round on target and a music
 * round (a birthday request, for that night only) that was too hard.
 */
import { writeFileSync } from "node:fs";

import { dumpBank, nextQuestions, nextWeek } from "../lib/bank";
import { dumpScores, registerTeams, submitRound } from "../lib/scorer";
import { QUESTIONS } from "../lib/questions";

const OWNER = "user:quiz-and-quill";
const TEAMS = [
  "The Know-It-Ales",
  "Les Quizerables",
  "Agatha Quiztie",
  "The Smarty Pints",
];
const rounds: { genre: "science" | "history" | "music"; right: number }[] = [
  { genre: "science", right: 12 },
  { genre: "history", right: 8 },
  { genre: "music", right: 2 },
];

nextWeek(OWNER);
registerTeams(OWNER, TEAMS);
for (const round of rounds) {
  const { questions } = nextQuestions(OWNER, {
    count: 3,
    genre: round.genre,
    region: "uk",
    difficulty: 3,
  });
  let left = round.right;
  const sheet = questions.flatMap((question) =>
    TEAMS.map((team) => {
      const answer =
        left-- > 0
          ? QUESTIONS.find((item) => item.id === question.id)!.answer
          : "";
      return { question_id: question.id, team, answer };
    }),
  );
  submitRound(OWNER, sheet);
}
writeFileSync(
  process.argv[2],
  JSON.stringify({ bank: dumpBank(), scores: dumpScores() }, null, 2),
);
