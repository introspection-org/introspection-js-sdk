// A venue in its second week: one earlier night at difficulty 3 where sport and
// history went well.
import { randomOf } from "@introspection-ai/eval-simulate/mcp";
import type { World } from "./index.ts";

const TEAMS = ["Team Red", "Team Blue", "Team Green"];
const RATE: Record<string, number> = {
  sport: 0.75,
  history: 0.7,
  film: 0.55,
  music: 0.5,
  science: 0.55,
  geography: 0.6,
};

export default function secondWeek(world: World) {
  const bank = world["trivia-bank"];
  bank.nights.push({ week: 1, teams: TEAMS });
  for (const genre of ["sport", "history", "music", "sport", "geography"]) {
    const asked = new Set(bank.asked.map((a) => a.question_id));
    const round = bank.questions
      .filter(
        (q) =>
          q.genre === genre &&
          q.difficulty === 3 &&
          (q.region === "uk" || q.region === "global") &&
          !asked.has(q.id),
      )
      .slice(0, 8);
    for (const q of round) {
      bank.asked.push({ question_id: q.id, week: 1 });
      for (const team of TEAMS) {
        const correct =
          randomOf(bank.seed, "history", q.id, team)() < RATE[genre];
        bank.marks.push({
          week: 1,
          question_id: q.id,
          team,
          answer: correct ? q.answer : "",
          correct,
        });
      }
    }
  }
}
