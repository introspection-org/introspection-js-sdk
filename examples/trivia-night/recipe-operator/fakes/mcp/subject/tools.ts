// The simulated trivia master: not a real server, so there is nothing to capture.
// One tool, `say`, through which the host talks to the venue's trivia master.
// prettier-ignore
export default {
  "tools": [
    {
      "name": "say",
      "description": "Say something to the venue's trivia master and get their reply. Send an empty text to hear how tonight opens.",
      "inputSchema": {
        "type": "object",
        "properties": { "text": { "type": "string" } },
        "required": ["text"],
        "additionalProperties": false
      }
    }
  ]
} as const;
