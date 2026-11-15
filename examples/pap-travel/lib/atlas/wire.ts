/**
 * Atlas's requests to a Company, each with the headers the protocol needs and
 * recorded, credentials shortened, for the page to show under the chat line
 * it belongs to.
 */
import "server-only";

import { decodeJwt, decodeProtectedHeader } from "jose";
import {
  exchanges,
  note,
} from "introspection-example-travel-demo-flow/demo/wire";

import { reachable } from "../origins";
import { type SessionClaims, sessionJwt } from "./identity";

type Entry = Parameters<typeof note>[0];

/**
 * Atlas's requests go on the page's one wire, beside the agent's tools and the
 * AAuth exchanges behind it. A read that brought nothing new, the same as the
 * one before, adds to that row instead of a new one.
 */
export function record(entry: Entry, quiet = false) {
  const last = exchanges().at(-1);
  if (
    quiet &&
    last?.label === entry.label &&
    last.status === entry.status &&
    last.from === entry.from
  ) {
    last.repeats += 1;
    last.request = entry.request;
    last.response = entry.response;
    return;
  }
  note(entry);
}

const SECRET_FIELDS = new Set([
  "client_assertion",
  "refresh_token",
  "access_token",
  "code",
  "code_verifier",
  "token",
]);
export const short = (value: string) =>
  value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-4)}` : value;

function shortenJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shortenJson);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SECRET_FIELDS.has(k) && typeof v === "string"
          ? short(v)
          : shortenJson(v),
      ]),
    );
  return value;
}

const pretty = (value: unknown) => JSON.stringify(shortenJson(value), null, 2);

/** The Session JWT as the Company reads it, for the page. */
function decoded(jwt: string) {
  const header = decodeProtectedHeader(jwt);
  return `Poppy-Session, decoded:\n${pretty({
    ...header,
    kid: short(String(header.kid)),
    poppy_dlg: short(String(header.poppy_dlg)),
  })}\n.\n${pretty(decodeJwt(jwt))}`;
}

export type Call = {
  label: string;
  method: "GET" | "POST";
  url: string;
  form?: Record<string, string>;
  json?: unknown;
  /** Sent with the Session header for this Session. */
  session?: SessionClaims;
  /** Sent signed in. */
  accessToken?: string;
  /** A read that may bring nothing new, folded into the row before it if so. */
  quiet?: boolean;
};

export type Answer = {
  status: number;
  body: Record<string, unknown>;
  challenge: string | null;
  /** Where a redirect from a discovery document points. */
  location?: string;
};

/** One request, never following a redirect: secrets don't go to a URL the Company redirects to (spec 3). */
export async function call(spec: Call): Promise<Answer> {
  reachable(spec.url);
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (spec.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(spec.form).toString();
  } else if (spec.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(spec.json);
  }
  if (spec.session)
    headers["Poppy-Session"] = await sessionJwt(
      spec.session,
      spec.method,
      spec.url,
      spec.accessToken,
    );
  if (spec.accessToken) headers.Authorization = `Bearer ${spec.accessToken}`;

  const response = await fetch(spec.url, {
    method: spec.method,
    headers,
    body,
    redirect: "manual",
    cache: "no-store",
  });
  const text = await response.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }

  const shownHeader = (name: string, value: string) =>
    name === "Authorization"
      ? `Bearer ${short(value.slice(7))}`
      : name === "Poppy-Session"
        ? short(value)
        : value;
  const shownBody = spec.form
    ? [...new URLSearchParams(body)]
        .map(([k, v]) => `${k}=${SECRET_FIELDS.has(k) ? short(v) : v}`)
        .join("\n&")
    : spec.json !== undefined
      ? pretty(spec.json)
      : undefined;
  const challenge = response.headers.get("www-authenticate");
  record(
    {
      from: "Atlas",
      to: "Flight Sector",
      label: spec.label,
      status: response.status,
      request: [
        `${spec.method} ${spec.url}`,
        ...Object.entries(headers).map(
          ([k, v]) => `${k}: ${shownHeader(k, v)}`,
        ),
        ...(shownBody ? ["", shownBody] : []),
        ...(headers["Poppy-Session"]
          ? ["", decoded(headers["Poppy-Session"])]
          : []),
      ].join("\n"),
      response: [
        `HTTP/1.1 ${response.status} ${response.statusText}`,
        ...(challenge ? [`WWW-Authenticate: ${challenge}`] : []),
        ...(parsed !== null && parsed !== ""
          ? ["", typeof parsed === "string" ? parsed : pretty(parsed)]
          : []),
      ].join("\n"),
    },
    // Folded only when it brought no events.
    Boolean(spec.quiet) &&
      Array.isArray((parsed as { events?: unknown[] })?.events) &&
      (parsed as { events: unknown[] }).events.length === 0,
  );
  const location = response.headers.get("location") ?? undefined;
  if (response.status >= 300 && response.status < 400) {
    if (spec.session || spec.accessToken || spec.form)
      throw new Error(`${spec.url} redirected; Atlas sent nothing on`);
    return { status: response.status, body: {}, challenge, location };
  }
  return {
    status: response.status,
    body:
      parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : {},
    challenge,
  };
}

/**
 * A discovery document (spec 3): redirects are followed one at a time, each
 * to https, and nothing secret is sent.
 */
export async function discover(
  label: string,
  url: string,
  finalPath?: string,
): Promise<{ url: URL; body: Record<string, unknown> }> {
  let at = url;
  for (let hop = 0; hop < 5; hop++) {
    const answer = await call({ label, method: "GET", url: at });
    if (answer.location) {
      at = reachable(new URL(answer.location, at).toString()).toString();
      continue;
    }
    const final = new URL(at);
    if (finalPath && (final.pathname !== finalPath || final.search))
      throw new Error(`${label}: ended at ${at}, not ${finalPath}`);
    if (answer.status !== 200)
      throw new Error(`${label}: HTTP ${answer.status}`);
    return { url: final, body: answer.body };
  }
  throw new Error(`${label}: too many redirects`);
}
