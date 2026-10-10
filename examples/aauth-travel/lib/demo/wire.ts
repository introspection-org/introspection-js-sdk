/**
 * Records what reaches the booking provider and Acme's Person Server while a
 * demo run is on, so the page can show it on the wire: the agent's requests
 * exactly as Introspection's egress signed them, Acme reading a booking
 * proposal, and a person's decision. Key discovery is left out: it is cached,
 * and says nothing about the flow.
 */
import "server-only";

export type Party =
  "Agent" | "Acme" | "Booking provider" | "Dana" | "Sam" | "Tools";

export type Exchange = {
  id: number;
  from: Party;
  to: Party;
  label: string;
  request: string;
  response: string;
  status: number;
  /** How many identical polls this row stands for. */
  repeats: number;
  /** The chat line this call belongs under. */
  turn: number;
};

type Wire = {
  recording: boolean;
  seq: number;
  turn: number;
  exchanges: Exchange[];
};
const wire = ((globalThis as unknown as { __demoWire?: Wire }).__demoWire ??= {
  recording: false,
  seq: 0,
  turn: 0,
  exchanges: [],
});

export const exchanges = () => wire.exchanges;

export function startRecording() {
  wire.recording = true;
  wire.exchanges = [];
}

export function stopRecording() {
  wire.recording = false;
  wire.exchanges = [];
}

/** Calls from here on belong under chat line `turn`. */
export function setTurn(turn: number) {
  wire.turn = turn;
}

/** Record something seen without an HTTP call here, such as one of the agent's tool calls. */
export function note(entry: Omit<Exchange, "id" | "repeats" | "turn">) {
  if (!wire.recording) return undefined;
  const exchange = { id: ++wire.seq, repeats: 1, turn: wire.turn, ...entry };
  wire.exchanges.push(exchange);
  return exchange;
}

/** The header a person's decision from the demo page carries, naming who decided. */
export const ACTOR_HEADER = "x-demo-actor";

const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
export const shorten = (text: string) =>
  text.replace(JWT, (jwt) => `${jwt.slice(0, 12)}…${jwt.slice(-4)}`);
const SHOWN_REQUEST = [
  "content-type",
  "signature-input",
  "signature",
  "signature-key",
  "content-digest",
];
const SHOWN_RESPONSE = [
  "aauth-requirement",
  "location",
  "retry-after",
  "content-type",
];

function label(
  method: string,
  path: string,
  status: number,
  requirement: string | null,
) {
  if (path === "/v1/search") return "Search offers";
  if (path === "/v1/reserve") {
    if (status === 401 && requirement?.includes("person-token"))
      return "Reserve → asks for a person token";
    if (status === 401 && requirement?.includes("auth-token"))
      return "Reserve → asks for an auth token";
    return status === 200 ? "Reserve → booked" : "Reserve";
  }
  if (path.startsWith("/r3/")) return "Acme reads the booking proposal";
  if (path === "/ps/mission") return "Propose the trip";
  if (path.startsWith("/ps/mission/")) return "Propose the trip complete";
  if (path === "/ps/person-token") return "Ask for a person token";
  if (path === "/ps/token") return "Exchange the resource token";
  if (path.startsWith("/ps/pending/"))
    return status === 202 ? "Poll: still waiting" : "Poll: decided";
  if (path.startsWith("/ps/approvals/")) return "Decide, with the emailed code";
  return `${method} ${path}`;
}

function headerLines(headers: Headers, shown: string[]) {
  return shown.flatMap((name) => {
    const value = headers.get(name);
    if (!value) return [];
    return [
      `${name}: ${name === "signature" ? `${value.slice(0, 24)}…` : shorten(value)}`,
    ];
  });
}

export function body(text: string) {
  if (!text) return [];
  try {
    return ["", shorten(JSON.stringify(JSON.parse(text), null, 2))];
  } catch {
    return ["", shorten(text.slice(0, 600))];
  }
}

function sender(path: string, headers: Headers): Party {
  if (path.startsWith("/r3/")) return "Acme";
  const actor = headers.get(ACTOR_HEADER);
  if (actor === "Dana" || actor === "Sam") return actor;
  return "Agent";
}

/**
 * Serve a request at `to` and record it. Wraps a route handler, so what is
 * shown is what arrived: the egress's signature and token, not a copy.
 */
export async function recorded(
  to: Party,
  request: Request,
  serve: () => Promise<Response>,
): Promise<Response> {
  if (!wire.recording) return serve();
  const copy = request.clone();
  const response = await serve();
  const url = new URL(copy.url);
  const path = url.pathname.replace(/^\/(booking|acme)(?=\/)/, "");
  if (
    path.startsWith("/.well-known/") ||
    path.endsWith("jwks.json") ||
    path === "/v1/audit"
  )
    return response;
  const requestText = [
    `${copy.method} https://${copy.headers.get("x-forwarded-host") ?? copy.headers.get("host") ?? url.host}${path}`,
    ...headerLines(copy.headers, SHOWN_REQUEST),
    ...body(await copy.text().catch(() => "")),
  ].join("\n");
  const responseText = [
    `HTTP/1.1 ${response.status} ${response.statusText}`,
    ...headerLines(response.headers, SHOWN_RESPONSE),
    ...body(
      await response
        .clone()
        .text()
        .catch(() => ""),
    ),
  ].join("\n");
  const from = sender(path, copy.headers);
  const entry = {
    from,
    to,
    label: label(
      copy.method,
      path,
      response.status,
      response.headers.get("aauth-requirement"),
    ),
    request: requestText,
    response: responseText,
    status: response.status,
  };
  const last = wire.exchanges.at(-1);
  if (
    last &&
    last.label === entry.label &&
    last.from === from &&
    entry.status === 202 &&
    last.status === 202
  ) {
    last.repeats += 1;
  } else {
    wire.exchanges.push({
      id: ++wire.seq,
      repeats: 1,
      turn: wire.turn,
      ...entry,
    });
  }
  return response;
}
