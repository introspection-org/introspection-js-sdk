// Each tool's successful answer, approximated from the owner's description of
// the bank (no captured contract or observed answers exist yet).
import { Type } from "typebox";

const Question = Type.Object({
  id: Type.String(),
  genre: Type.String(),
  region: Type.String(),
  difficulty: Type.Integer(),
  text: Type.String(),
});

export const answers = {
  list_questions: {
    format: "json",
    schema: Type.Object({
      questions: Type.Array(Question),
      total_available: Type.Integer(),
    }),
  },
  score_round: {
    format: "json",
    schema: Type.Object({
      round_id: Type.String(),
      teams: Type.Array(
        Type.Object({
          team: Type.String(),
          score: Type.Integer(),
          out_of: Type.Integer(),
        }),
      ),
      answers: Type.Array(
        Type.Object({ question_id: Type.String(), answer: Type.String() }),
      ),
    }),
  },
  round_summary: {
    format: "json",
    schema: Type.Object({
      round_id: Type.String(),
      questions: Type.Integer(),
      teams: Type.Integer(),
      percent_correct: Type.Integer(),
      difficulty: Type.Union([Type.Integer(), Type.Null()]),
      by_genre: Type.Array(
        Type.Object({
          genre: Type.String(),
          questions: Type.Integer(),
          percent_correct: Type.Integer(),
        }),
      ),
      hardest: Type.Array(
        Type.Object({
          question_id: Type.String(),
          percent_correct: Type.Integer(),
        }),
      ),
      easiest: Type.Array(
        Type.Object({
          question_id: Type.String(),
          percent_correct: Type.Integer(),
        }),
      ),
    }),
  },
} as const;
