// Each tool's successful answer, by hand. The real bank has not been observed yet,
// so every shape here is approximated from the captured tool descriptions.
import { Type } from "typebox";

const Standing = Type.Object(
  { team: Type.String(), points: Type.Integer() },
  { additionalProperties: false },
);
const Rate = Type.Object(
  {
    asked: Type.Integer(),
    correct: Type.Integer(),
    correct_rate: Type.Number(),
  },
  { additionalProperties: false },
);

export const answers = {
  start_night: {
    format: "json",
    schema: Type.Object(
      { week: Type.Integer() },
      { additionalProperties: false },
    ),
  },
  register_teams: {
    format: "json",
    schema: Type.Object(
      {
        week: Type.Integer(),
        teams: Type.Array(
          Type.Object(
            { name: Type.String(), played_here_before: Type.Boolean() },
            { additionalProperties: false },
          ),
        ),
      },
      { additionalProperties: false },
    ),
  },
  next_questions: {
    format: "json",
    schema: Type.Object(
      {
        questions: Type.Array(
          Type.Object(
            {
              id: Type.String(),
              genre: Type.String(),
              region: Type.String(),
              difficulty: Type.Integer(),
              text: Type.String(),
            },
            { additionalProperties: false },
          ),
        ),
        relaxed: Type.Union([Type.String(), Type.Null()]),
      },
      { additionalProperties: false },
    ),
  },
  submit_round: {
    format: "json",
    schema: Type.Object(
      {
        week: Type.Integer(),
        marks: Type.Array(
          Type.Object(
            {
              question_id: Type.String(),
              team: Type.String(),
              answer: Type.String(),
              correct: Type.Boolean(),
              correct_answer: Type.String(),
            },
            { additionalProperties: false },
          ),
        ),
        round_points: Type.Array(Standing),
        standings: Type.Array(Standing),
      },
      { additionalProperties: false },
    ),
  },
  round_summary: {
    format: "json",
    schema: Type.Object(
      {
        week: Type.Integer(),
        by_genre: Type.Record(Type.String(), Rate),
        by_difficulty: Type.Record(Type.String(), Rate),
      },
      { additionalProperties: false },
    ),
  },
  scoreboard: {
    format: "json",
    schema: Type.Object(
      { scope: Type.String(), standings: Type.Array(Standing) },
      { additionalProperties: false },
    ),
  },
} as const;
