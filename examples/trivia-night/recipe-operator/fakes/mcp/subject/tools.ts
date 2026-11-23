// The trivia master's voice in a simulated series. Not a real server: this
// fake exists only for the memory search, and the Recipe never binds it.
// prettier-ignore
export default {
  "tools": [
    {
      "name": "say",
      "description": "Say something to the venue's trivia master and get their reply. An empty text starts the night and returns their opening.",
      "inputSchema": {
        "type": "object",
        "properties": { "text": { "type": "string" } },
        "required": ["text"],
        "additionalProperties": false
      },
      "annotations": { "readOnlyHint": false }
    }
  ]
} as const;
