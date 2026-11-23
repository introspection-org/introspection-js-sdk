// PROVISIONAL CONTRACT, written by hand from the owner's description of the
// question bank, because the real server is not bound yet. The workflow says
// `tools.ts` is written only by `introspection bindings mcp capture`; at
// deploy, deploy-connect binds the real server and captures over this file,
// and the fake's handlers and answers are then rewritten to the real contract.
// prettier-ignore
export default {
  "tools": [
    {
      "name": "list_questions",
      "description": "List questions from the bank that this venue has not been asked yet, filtered by difficulty (1 easiest to 5 hardest), and optionally by genre and region. Region is the audience a question is written for: AU, UK, US, or general (anyone can answer it). Answers are not included; the bank reveals them when the round is scored. An unknown genre is an error that lists the bank's genres.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "difficulty": { "type": "integer", "minimum": 1, "maximum": 5, "description": "Difficulty level, 1 to 5." },
          "genre": { "type": "string", "description": "Genre, such as music, film or sport. Omit for any genre." },
          "region": { "type": "string", "enum": ["AU", "UK", "US", "general"], "description": "Audience region. Omit for any region." },
          "limit": { "type": "integer", "minimum": 1, "maximum": 30, "default": 10, "description": "Most questions to return." }
        },
        "required": ["difficulty"],
        "additionalProperties": false
      },
      "annotations": { "readOnlyHint": true }
    },
    {
      "name": "score_round",
      "description": "Score one round: the ids of the questions asked, in order, and each team's answers in the same order (an empty string for a blank). Returns each team's score and the correct answers. The questions count as asked at this venue from then on. Returns a round_id for round_summary.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "question_ids": { "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 20 },
          "teams": {
            "type": "array",
            "minItems": 1,
            "items": {
              "type": "object",
              "properties": {
                "team": { "type": "string" },
                "answers": { "type": "array", "items": { "type": "string" } }
              },
              "required": ["team", "answers"],
              "additionalProperties": false
            }
          }
        },
        "required": ["question_ids", "teams"],
        "additionalProperties": false
      },
      "annotations": { "readOnlyHint": false }
    },
    {
      "name": "round_summary",
      "description": "Summarise how the room did in a scored round: the share of answers right overall and per genre, the round's difficulty, and the hardest and easiest questions.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "round_id": { "type": "string" }
        },
        "required": ["round_id"],
        "additionalProperties": false
      },
      "annotations": { "readOnlyHint": true }
    }
  ]
} as const;
