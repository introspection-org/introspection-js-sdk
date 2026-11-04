/**
 * What Browserbase's hosted MCP (https://mcp.browserbase.com/mcp) answered on
 * 11 October 2026 for one real search, kept so the mock answers the same way.
 * The tool list is verbatim; the two extractions are the pages Google Flights
 * returned for SFO→SYD and SYD→SFO. Session ids and the signed CDP URL are not
 * kept: they identify a live browser.
 */
export const PROTOCOL_VERSION = "2025-03-26";
export const CAPABILITIES = { logging: {}, tools: { listChanged: true } };
export const TOOLS = [
  {
    name: "start",
    description: "Create or reuse a Browserbase session",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          description:
            "Optional Browserbase session ID. For `start`, pass an existing session ID to reuse it instead of creating a new session. For other tools, pass the sessionId returned by `start` to target or reattach to that session; if omitted, they use the current active session.",
        },
      },
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    },
    execution: {
      taskSupport: "forbidden",
    },
  },
  {
    name: "end",
    description: "Close the current Browserbase session",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          minLength: 1,
          description:
            "Optional Browserbase session ID. For `start`, pass an existing session ID to reuse it instead of creating a new session. For other tools, pass the sessionId returned by `start` to target or reattach to that session; if omitted, they use the current active session.",
        },
      },
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    },
    execution: {
      taskSupport: "forbidden",
    },
  },
  {
    name: "navigate",
    description: "Navigate to a URL",
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          minLength: 1,
        },
        sessionId: {
          type: "string",
          minLength: 1,
          description:
            "Optional Browserbase session ID. For `start`, pass an existing session ID to reuse it instead of creating a new session. For other tools, pass the sessionId returned by `start` to target or reattach to that session; if omitted, they use the current active session.",
        },
      },
      required: ["url"],
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    },
    execution: {
      taskSupport: "forbidden",
    },
  },
  {
    name: "act",
    description: "Perform an action on the page",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          minLength: 1,
        },
        sessionId: {
          type: "string",
          minLength: 1,
          description:
            "Optional Browserbase session ID. For `start`, pass an existing session ID to reuse it instead of creating a new session. For other tools, pass the sessionId returned by `start` to target or reattach to that session; if omitted, they use the current active session.",
        },
      },
      required: ["action"],
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    },
    execution: {
      taskSupport: "forbidden",
    },
  },
  {
    name: "observe",
    description: "Observe actionable elements on the page",
    inputSchema: {
      type: "object",
      properties: {
        instruction: {
          type: "string",
          minLength: 1,
        },
        sessionId: {
          type: "string",
          minLength: 1,
          description:
            "Optional Browserbase session ID. For `start`, pass an existing session ID to reuse it instead of creating a new session. For other tools, pass the sessionId returned by `start` to target or reattach to that session; if omitted, they use the current active session.",
        },
      },
      required: ["instruction"],
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    },
    execution: {
      taskSupport: "forbidden",
    },
  },
  {
    name: "extract",
    description: "Extract data from the page",
    inputSchema: {
      type: "object",
      properties: {
        instruction: {
          type: "string",
        },
        sessionId: {
          type: "string",
          minLength: 1,
          description:
            "Optional Browserbase session ID. For `start`, pass an existing session ID to reuse it instead of creating a new session. For other tools, pass the sessionId returned by `start` to target or reattach to that session; if omitted, they use the current active session.",
        },
      },
      additionalProperties: false,
      $schema: "http://json-schema.org/draft-07/schema#",
    },
    execution: {
      taskSupport: "forbidden",
    },
  },
];

/** The navigations recorded, with the extraction each page gave for: */
export const RECORDED_INSTRUCTION =
  "List every flight shown, in order: airline, flight numbers if shown, departure time, arrival time, duration, stops and price in USD.";
export const RECORDED_SEARCHES: {
  url: string;
  from: string;
  to: string;
  extraction: string;
}[] = [
  {
    url: "https://www.google.com/travel/flights?q=Flights%20from%20SFO%20to%20SYD%20on%202026-10-18%20one%20way%20economy",
    from: "SFO",
    to: "SYD",
    extraction:
      '[{"airline": "Alaska", "flight_numbers": null, "departure_time": "7:48 PM", "arrival_time": "6:50 PM", "duration": "29 hr 2 min", "stops": "1 stop", "price": "$706"}, {"airline": "Qantas", "flight_numbers": null, "departure_time": "9:30 PM", "arrival_time": "6:25 AM", "duration": "14 hr 55 min", "stops": "Nonstop", "price": "$963"}, {"airline": "United", "flight_numbers": null, "departure_time": "11:05 PM", "arrival_time": "7:55 AM", "duration": "14 hr 50 min", "stops": "Nonstop", "price": "$1,164"}, {"airline": "Alaska", "flight_numbers": null, "departure_time": "10:13 PM", "arrival_time": "6:50 PM", "duration": "26 hr 37 min", "stops": "2 stops", "price": "$849"}, {"airline": "United, ANA", "flight_numbers": null, "departure_time": "12:03 PM", "arrival_time": "10:25 AM", "duration": "28 hr 22 min", "stops": "2 stops", "price": "$1,013"}, {"airline": "Air New Zealand", "flight_numbers": null, "departure_time": "9:05 PM", "arrival_time": "9:50 PM", "duration": "30 hr 45 min", "stops": "1 stop", "price": "$1,042"}, {"airline": "Fiji Airways", "flight_numbers": null, "departure_time": "11:10 PM", "arrival_time": "12:50 PM", "duration": "19 hr 40 min", "stops": "1 stop", "price": "$1,486"}, {"airline": "Fiji Airways, Qantas", "flight_numbers": null, "departure_time": "11:10 PM", "arrival_time": "6:55 PM", "duration": "25 hr 45 min", "stops": "1 stop", "price": "$1,797"}, {"airline": "China Southern", "flight_numbers": null, "departure_time": "12:35 AM", "arrival_time": "8:25 PM", "duration": "25 hr 50 min", "stops": "1 stop", "price": "$1,937"}, {"airline": "Cathay Pacific", "flight_numbers": null, "departure_time": "12:20 AM", "arrival_time": "8:45 PM", "duration": "26 hr 25 min", "stops": "1 stop", "price": "$2,838"}]',
  },
  {
    url: "https://www.google.com/travel/flights?q=Flights%20from%20SYD%20to%20SFO%20on%202026-10-24%20one%20way%20economy",
    from: "SYD",
    to: "SFO",
    extraction:
      "[4-18417] Cathay Pacific, Flight 828, 3:05 PM, 9:55 PM, 24 hr 50 min, 1 stop, $828\n[4-18573] China Southern, Flight 969, 3:15 PM, 8:40 PM, 23 hr 25 min, 1 stop, $969\n[4-18729] Air Canada, Flight 981, 10:20 AM, 10:20 AM, 18 hr, 1 stop, $981\n[4-18885] Alaska, Flight 981, 8:45 PM, 10:52 PM, 20 hr 7 min, 1 stop, $981\n[4-19045] United, Virgin Australia, Flight 1,371, 11:20 AM, 6:50 AM, 13 hr 30 min, Nonstop, $1,371\n[4-19409] Air New Zealand, Flight 764, 7:20 PM, 12:05 PM, 34 hr 45 min, 1 stop, $764\n[4-19581] Philippine Airlines, Flight 831, 11:15 AM, 9:10 PM, 27 hr 55 min, 1 stop, $831\n[4-19751] Air Canada, United, Flight 1,030, 10:20 AM, 12:11 PM, 19 hr 51 min, 1 stop, $1,030\n[4-19907] American, Qantas, Flight 1,221, 10:10 AM, 11:02 AM, 18 hr 52 min, 1 stop, $1,221\n[4-20071] Qantas, American, Flight 1,222, 6:50 PM, 7:03 PM, 18 hr 13 min, 1 stop, $1,222\n[4-20227] Delta, Flight 1,236, 10:15 AM, 8:59 AM, 16 hr 44 min, 1 stop, $1,236",
  },
];
