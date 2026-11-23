// Written by `introspection bindings mcp capture`. Do not edit.
// biome-ignore-all format: the CLI writes this file and reads it back
// prettier-ignore
export default {
  "tools": [
    {
      "description": "Get questions this venue has never been asked. The bank excludes every question already asked here, so never track that yourself. When the filter runs dry it is relaxed and `relaxed` says how.",
      "inputSchema": {
        "additionalProperties": false,
        "properties": {
          "count": {
            "maximum": 10,
            "minimum": 1,
            "type": "integer"
          },
          "difficulty": {
            "maximum": 5,
            "minimum": 1,
            "type": "integer"
          },
          "genre": {
            "enum": [
              "music",
              "film",
              "sport",
              "science",
              "history",
              "geography"
            ],
            "type": "string"
          },
          "region": {
            "enum": [
              "global",
              "au",
              "uk",
              "us"
            ],
            "type": "string"
          }
        },
        "required": [
          "count"
        ],
        "type": "object"
      },
      "name": "next_questions"
    },
    {
      "description": "Set tonight's teams by name, after start_night. Returns which teams have played at this venue before.",
      "inputSchema": {
        "additionalProperties": false,
        "properties": {
          "names": {
            "items": {
              "type": "string"
            },
            "maxItems": 20,
            "minItems": 1,
            "type": "array"
          }
        },
        "required": [
          "names"
        ],
        "type": "object"
      },
      "name": "register_teams"
    },
    {
      "description": "How this venue answered in one week, by genre and by difficulty; the current week when `week` is omitted.",
      "inputSchema": {
        "additionalProperties": false,
        "properties": {
          "week": {
            "minimum": 1,
            "type": "integer"
          }
        },
        "type": "object"
      },
      "name": "round_summary"
    },
    {
      "description": "The standings: tonight's, or the season's across every night.",
      "inputSchema": {
        "additionalProperties": false,
        "properties": {
          "scope": {
            "enum": [
              "tonight",
              "season"
            ],
            "type": "string"
          }
        },
        "required": [
          "scope"
        ],
        "type": "object"
      },
      "name": "scoreboard"
    },
    {
      "description": "Start this venue's next quiz night. Returns its week number. Call once before the first round.",
      "inputSchema": {
        "additionalProperties": false,
        "properties": {},
        "type": "object"
      },
      "name": "start_night"
    },
    {
      "description": "Submit one round's answer sheet: every team's answer to every question in the round, in one call. The bank marks each answer; never mark one yourself. An empty answer is a blank. Returns each mark, the round's points and tonight's standings.",
      "inputSchema": {
        "additionalProperties": false,
        "properties": {
          "answers": {
            "items": {
              "additionalProperties": false,
              "properties": {
                "answer": {
                  "type": "string"
                },
                "question_id": {
                  "type": "string"
                },
                "team": {
                  "type": "string"
                }
              },
              "required": [
                "question_id",
                "team",
                "answer"
              ],
              "type": "object"
            },
            "minItems": 1,
            "type": "array"
          }
        },
        "required": [
          "answers"
        ],
        "type": "object"
      },
      "name": "submit_round"
    }
  ]
} as const;
