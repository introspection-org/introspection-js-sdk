// Flight Sector booking tools: plain HTTPS calls through the platform's egress.
// A trip is an AAuth mission: the agent proposes it to the traveller's Person
// Server, which the egress reaches at person-server.aauth, and the traveller's
// company approves it once. Bookings then go to the `aauth` booking connector;
// egress signs them and gets each auth token under the mission. Nothing here
// holds a credential; anything awaiting a person comes back as 428, and the
// runtime reports it (introspection-cloud connectors-aauth-b2b2c.md §12.3).
import { Type } from "typebox";

const BOOKING_API_URL = (process.env.BOOKING_API_URL ?? "https://api.booking.example").replace(/\/$/, "");
const PERSON_SERVER_URL = "https://person-server.aauth";
const REQUEST_TIMEOUT_MS = 20_000;

async function call(path, body, signal, base = BOOKING_API_URL) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  return { status: response.status, text: await response.text() };
}

function result(res) {
  return {
    content: [{ type: "text", text: `HTTP ${res.status}\n${res.text}` }],
    details: { status: res.status },
    // A 428 is the approval steer, which carries what to tell the person.
    isError: res.status >= 400 && res.status !== 428,
  };
}

export function registerBookingTools(pi) {
  pi.registerTool({
    name: "propose_trip",
    label: "Propose the trip",
    description:
      "Propose the whole trip to the traveller's company before booking anything. Its manager approves it once, budget and all; bookings within it then need no one. Returns the approved mission and its `s256`.",
    promptSnippet: "Propose the trip, with its budget, before booking anything.",
    promptGuidelines: [
      "Describe the trip in Markdown: who travels, where, when, what will be booked, and the budget as \"up to $N\".",
      "Propose once per trip, before the first booking.",
    ],
    parameters: Type.Object({
      description: Type.String({ description: "Markdown: the trip, ending with its budget, e.g. 'up to $3,000'" }),
    }),
    async execute(_toolCallId, params, signal) {
      return result(await call("/mission", { description: params.description }, signal, PERSON_SERVER_URL));
    },
  });

  pi.registerTool({
    name: "complete_trip",
    label: "Report the trip booked",
    description: "Tell the traveller's company the trip is booked. The traveller accepts it, which ends the mission.",
    parameters: Type.Object({
      s256: Type.String({ description: "The mission's s256, from propose_trip" }),
      summary: Type.String({ description: "Markdown: what was booked, and the total" }),
    }),
    async execute(_toolCallId, params, signal) {
      return result(
        await call(`/mission/${params.s256}`, { action: "completion", summary: params.summary }, signal, PERSON_SERVER_URL),
      );
    },
  });

  pi.registerTool({
    name: "search_offers",
    label: "Search travel",
    description:
      "Search flights or hotels. Every offer carries a signed `quote`; pass the offer's `offer_id` and `quote` unchanged to book_item.",
    promptSnippet: "Search flights or hotels for signed, bookable offers.",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("flight"), Type.Literal("hotel")]),
      from: Type.Optional(Type.String({ description: "Flight origin IATA code, e.g. SFO" })),
      to: Type.Optional(Type.String({ description: "Flight destination IATA code, e.g. SYD" })),
      date: Type.Optional(Type.String({ description: "Flight date, YYYY-MM-DD" })),
      cabin: Type.Optional(Type.String({ description: "economy, premium, business or first" })),
      city: Type.Optional(Type.String({ description: "Hotel city IATA code, e.g. SYD" })),
      check_in: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
      check_out: Type.Optional(Type.String({ description: "YYYY-MM-DD" })),
    }),
    async execute(_toolCallId, params, signal) {
      return result(await call("/v1/search", params, signal));
    },
  });

  pi.registerTool({
    name: "book_item",
    label: "Book travel",
    description:
      "Reserve one offer under the approved trip. Within its budget that is immediate; over what is left, it goes to the traveller's manager.",
    promptSnippet: "Reserve one signed offer the traveller has confirmed.",
    promptGuidelines: [
      "Set purpose to business only for legs that serve the work trip; anything else is personal with payer traveler.",
      "Book one item per call, and only after the traveller has confirmed it.",
    ],
    parameters: Type.Object({
      offer_id: Type.String(),
      quote: Type.String({ description: "The offer's signed quote, unchanged" }),
      purpose: Type.Union([Type.Literal("business"), Type.Literal("personal")]),
      payer: Type.Union([Type.Literal("company"), Type.Literal("traveler")]),
    }),
    async execute(_toolCallId, params, signal) {
      return result(await call("/v1/reserve", params, signal));
    },
  });
}

export default function (pi) {
  registerBookingTools(pi);
}
