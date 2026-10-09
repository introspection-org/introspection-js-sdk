// Flight Sector booking tools: plain HTTPS calls through the platform's egress.
// The booking connector is `aauth`: egress signs each request with the
// session's key, presents the agent token, and exchanges the provider's
// resource token at the traveller's Person Server for an auth token. Nothing
// here holds a credential or knows about AAuth; a booking awaiting the
// traveller's company comes back as 428, and the runtime reports it
// (introspection-cloud connectors-aauth-b2b2c.md §12.3).
import { Type } from "typebox";

const BOOKING_API_URL = (process.env.BOOKING_API_URL ?? "https://api.booking.example").replace(/\/$/, "");
const REQUEST_TIMEOUT_MS = 20_000;

async function call(path, body, signal) {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const response = await fetch(`${BOOKING_API_URL}${path}`, {
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
      "Reserve one offer. The traveller's company approves each booking: within its policy that is immediate, otherwise it goes to their manager.",
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
