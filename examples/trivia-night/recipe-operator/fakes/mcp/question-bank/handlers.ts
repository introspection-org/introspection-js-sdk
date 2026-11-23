import {
  type McpServer,
  text,
  toolsOf,
} from "@introspection-ai/eval-simulate/mcp";
import { contract } from "./contract.ts";
import type { State } from "./entities.ts";
import {
  GENRES,
  REGIONS,
  cellKey,
  parseId,
  questionOf,
} from "../../scenarios/bank.ts";

const { config, answer } = toolsOf(contract);

const normalise = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/^(the|a|an) /, "")
    .trim();

const pct = (n: number, d: number) => (d === 0 ? 0 : Math.round((100 * n) / d));

export function register(server: McpServer, state: State) {
  server.registerTool(
    "list_questions",
    config("list_questions"),
    async ({ difficulty, genre, region, limit }) => {
      if (genre !== undefined && !(GENRES as readonly string[]).includes(genre))
        return text(
          `Unknown genre "${genre}". Genres: ${[...GENRES].sort().join(", ")}.`,
          true,
        );
      const asked = new Set(state.asked);
      const want = limit ?? 10;
      const questions = [];
      let total = 0;
      for (const g of genre === undefined ? GENRES : [genre])
        for (const r of region === undefined ? REGIONS : [region]) {
          const n = state.supply[cellKey(g, r, difficulty)] ?? 0;
          for (let k = 1; k <= n; k++) {
            const q = questionOf(g, r, difficulty, k);
            if (asked.has(q.id)) continue;
            total++;
            if (questions.length < want) {
              const { answer: _a, ...shown } = q;
              questions.push(shown);
            }
          }
        }
      return answer("list_questions", { questions, total_available: total });
    },
  );

  server.registerTool(
    "score_round",
    config("score_round"),
    async ({ question_ids, teams }) => {
      const inBank = (id: string) => {
        const q = parseId(id);
        if (!q) return null;
        const [g, r, d, k] = [
          q.genre,
          q.region,
          q.difficulty,
          Number(id.slice(-3)),
        ];
        return k <= (state.supply[cellKey(g, r, d)] ?? 0) ? q : null;
      };
      const byId = new Map(
        question_ids.flatMap((id) => {
          const q = inBank(id);
          return q ? [[id, q] as const] : [];
        }),
      );
      const unknown = question_ids.filter((id) => !byId.has(id));
      if (unknown.length)
        return text(`Unknown question ids: ${unknown.join(", ")}.`, true);
      if (new Set(question_ids).size !== question_ids.length)
        return text("A question id appears twice.", true);
      const bad = teams.find((t) => t.answers.length !== question_ids.length);
      if (bad)
        return text(
          `Team "${bad.team}" has ${bad.answers.length} answers for ${question_ids.length} questions.`,
          true,
        );
      const qs = question_ids.map((id) => byId.get(id)!);
      const correct = qs.map(() => 0);
      const scored = teams.map((t) => {
        let score = 0;
        t.answers.forEach((a, i) => {
          if (a.trim() && normalise(a) === normalise(qs[i].answer)) {
            score++;
            correct[i]++;
          }
        });
        return { team: t.team, score, out_of: qs.length };
      });
      const round_id = `round-${state.rounds.length + 1}`;
      state.rounds.push({
        id: round_id,
        question_ids: [...question_ids],
        teams: scored,
        correct_per_question: correct,
      });
      for (const id of question_ids)
        if (!state.asked.includes(id)) state.asked.push(id);
      return answer("score_round", {
        round_id,
        teams: scored,
        answers: qs.map((q) => ({ question_id: q.id, answer: q.answer })),
      });
    },
  );

  server.registerTool(
    "round_summary",
    config("round_summary"),
    async ({ round_id }) => {
      const round = state.rounds.find((r) => r.id === round_id);
      if (!round) return text(`No scored round "${round_id}".`, true);
      const qs = round.question_ids.map((id) => parseId(id)!);
      const n = round.teams.length;
      const per = qs.map((q, i) => ({
        question_id: q.id,
        percent_correct: pct(round.correct_per_question[i], n),
      }));
      const levels = [...new Set(qs.map((q) => q.difficulty))];
      const genres = [...new Set(qs.map((q) => q.genre))];
      const sorted = [...per].sort(
        (a, b) => a.percent_correct - b.percent_correct,
      );
      return answer("round_summary", {
        round_id,
        questions: qs.length,
        teams: n,
        percent_correct: pct(
          round.correct_per_question.reduce((a, b) => a + b, 0),
          n * qs.length,
        ),
        difficulty: levels.length === 1 ? levels[0] : null,
        by_genre: genres.map((g) => {
          const idx = qs.flatMap((q, i) => (q.genre === g ? [i] : []));
          return {
            genre: g,
            questions: idx.length,
            percent_correct: pct(
              idx.reduce((a, i) => a + round.correct_per_question[i], 0),
              n * idx.length,
            ),
          };
        }),
        hardest: sorted.slice(0, 3),
        easiest: sorted.slice(-3).reverse(),
      });
    },
  );
}
