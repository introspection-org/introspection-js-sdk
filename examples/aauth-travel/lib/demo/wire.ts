/**
 * Records the HTTP the demo page's run makes, so the page can show it on the
 * wire. The agent's calls carry their actor (the agent, Dana, Sam) in async
 * context; Acme reading a booking proposal is recorded as Acme. Key discovery
 * by the servers is left out: it is cached, and says nothing about the flow.
 */
import "server-only";

import { AsyncLocalStorage } from "node:async_hooks";

import {
  BOOKING_ISSUER,
  DEMO_AGENT_PROVIDER,
  PERSON_SERVER_URL,
} from "../origins";

export type Actor = "Agent" | "Dana" | "Sam" | "Acme";
export type Party = Actor | "Rails" | "Booking provider" | "Agent Provider";

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

const actor = new AsyncLocalStorage<Actor>();

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

/** Calls from here on belong under chat line `turn`. */
export function setTurn(turn: number) {
  wire.turn = turn;
}

export const exchanges = () => wire.exchanges;

export function startRecording() {
  wire.recording = true;
  wire.exchanges = [];
}

export function stopRecording() {
  wire.recording = false;
  wire.exchanges = [];
}

/** Record a step that makes no HTTP call, such as the rails' evaluation. */
export function note(entry: Omit<Exchange, "id" | "repeats" | "turn">) {
  if (wire.recording)
    wire.exchanges.push({
      id: ++wire.seq,
      repeats: 1,
      turn: wire.turn,
      ...entry,
    });
}

/** Run `work` as `who`: every request it makes is recorded as theirs. */
export function as<T>(who: Actor, work: () => Promise<T>): Promise<T> {
  return actor.run(who, work);
}

const host = (url: string) => new URL(url).host;
const PARTIES: Record<string, Party> = {
  [host(BOOKING_ISSUER)]: "Booking provider",
  [host(PERSON_SERVER_URL)]: "Acme",
  [host(DEMO_AGENT_PROVIDER)]: "Agent Provider",
};

const JWT = /eyJ[\w-]+\.[\w-]+\.[\w-]+/g;
const shorten = (text: string) =>
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
  if (path.startsWith("/.well-known/")) return "Discover the Person Server";
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
    const short =
      name === "signature" ? `${value.slice(0, 24)}…` : shorten(value);
    return [`${name}: ${short}`];
  });
}

function body(text: string) {
  if (!text) return [];
  try {
    return ["", shorten(JSON.stringify(JSON.parse(text), null, 2))];
  } catch {
    return ["", shorten(text.slice(0, 600))];
  }
}

async function record(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  response: Response,
) {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const to = PARTIES[url.host];
  if (!to) return;
  const who = actor.getStore();
  const discovery =
    url.pathname.startsWith("/.well-known/") ||
    url.pathname.endsWith("jwks.json");
  if (!who && (discovery || to !== "Booking provider")) return;
  const from: Party = who ?? "Acme";
  if (to === "Agent Provider") return;

  const requestText = [
    `${request.method} ${url.origin}${url.pathname}`,
    ...headerLines(request.headers, SHOWN_REQUEST),
    ...body(typeof init?.body === "string" ? init.body : ""),
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
  const entry = {
    from,
    to,
    label: label(
      request.method,
      url.pathname,
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
    return;
  }
  wire.exchanges.push({
    id: ++wire.seq,
    repeats: 1,
    turn: wire.turn,
    ...entry,
  });
}

/** Wrap `fetch` once per process, so whatever calls it is seen. */
export function installRecorder() {
  const store = globalThis as unknown as { __demoFetchWrapped?: boolean };
  if (store.__demoFetchWrapped) return;
  store.__demoFetchWrapped = true;
  const original = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input, init) => {
    const response = await original(input, init);
    if (wire.recording)
      await record(input, init, response).catch(() => undefined);
    return response;
  };
}
