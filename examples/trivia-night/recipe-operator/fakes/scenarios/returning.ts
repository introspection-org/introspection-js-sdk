// A venue in its fourth week: three earlier nights at difficulty 3, where the
// crowd did well on film and music and less well on everything else.
import { randomOf } from "@introspection-ai/eval-simulate/mcp";
import type { World } from "./index.ts";

const HISTORY_TEAMS = ["Team North", "Team South", "Team East", "Team West"];
const RATE: Record<string, number> = {
  film: 0.8,
  music: 0.8,
  sport: 0.6,
  science: 0.55,
  history: 0.6,
  geography: 0.6,
};
const PLAYED = [
  ["film", "music", "sport", "history", "science"],
  ["music", "film", "geography", "sport", "history"],
  ["film", "music", "science", "geography", "sport"],
];

export default function returning(world: World) {
  const bank = world["trivia-bank"];
  PLAYED.forEach((genres, i) => {
    const week = i + 1;
    bank.nights.push({ week, teams: HISTORY_TEAMS });
    for (const genre of genres) {
      const asked = new Set(bank.asked.map((a) => a.question_id));
      const round = bank.questions
        .filter(
          (q) =>
            q.genre === genre &&
            q.difficulty === 3 &&
            (q.region === "au" || q.region === "global") &&
            !asked.has(q.id),
        )
        .slice(0, 8);
      for (const q of round) {
        bank.asked.push({ question_id: q.id, week });
        for (const team of HISTORY_TEAMS) {
          const correct =
            randomOf(bank.seed, "history", q.id, team)() < RATE[genre];
          bank.marks.push({
            week,
            question_id: q.id,
            team,
            answer: correct ? q.answer : "",
            correct,
          });
        }
      }
    }
  });
}
