/**
 * Atlas, scripted: Sam's half of the chat is fixed, and each step makes the
 * real PAP calls to Flight Sector (spec §3 discovery, §4 sessions and Direct
 * Sign-In, §7 conversations). The page reads `snapshot()`.
 */
import "server-only";

import { base64url } from "jose";

import { once } from "../once";
import { COMPANY_URL } from "../origins";
import {
  assertion,
  call,
  CLIENT_ID,
  type Exchange,
  newKeyPair,
  type KeyPair,
  REDIRECT_URI,
} from "./client";

type Chat = {
  from: "sam" | "atlas";
  text: string;
  signIn?: string;
  choices?: { id: string; label: string }[];
};

type Seen = {
  from: "Atlas" | "Flight Sector";
  text: string;
  data?: unknown;
  note?: string;
};

type Company = {
  domain: string;
  issuer: string;
  tokenEndpoint: string;
  authorizationEndpoint: string;
  revocationEndpoint: string;
  conversations: string;
};

type Session = { id: string; token: string; scopes: string[]; key: KeyPair };

type Option = {
  id: string;
  flight: string;
  arrives: string;
  fare_difference: number;
};

type Demo = {
  step: "start" | "sign-in" | "choose" | "done" | "disconnected";
  chat: Chat[];
  seen: Seen[];
  exchanges: Exchange[];
  result?: Record<string, string>;
  company?: Company;
  /** Sam's User ID at Flight Sector: random, so it says nothing about who Sam is. */
  userId: string;
  session?: Session;
  accountToken?: string;
  conversation?: { id: string; cursor?: string };
  pending?: { state: string; verifier: string; scope: string };
  options?: Option[];
  error?: string;
};

const fresh = (): Demo => ({
  step: "start",
  chat: [],
  seen: [],
  exchanges: [],
  userId: `usr_${base64url.encode(crypto.getRandomValues(new Uint8Array(9)))}`,
});

const store = once("atlas_demo", () => ({ demo: fresh() }));
const demo = () => store.demo;
const record = (exchange: Exchange) => demo().exchanges.push(exchange);

export const SAM_ASKS =
  "My QF74 to Sydney is delayed six hours, and I have a 9am meeting on the 20th. Can you get me there in time?";

export function snapshot() {
  const { step, chat, seen, exchanges, result, error } = demo();
  return { step, chat, seen, exchanges, result, error };
}

export function reset() {
  store.demo = fresh();
}

/** Find Flight Sector and check its OAuth server speaks for its domain (spec §3.2). */
async function discover(): Promise<Company> {
  const domain = new URL(COMPANY_URL).hostname;
  const doc = (
    await call(record, {
      label: "Discover Flight Sector",
      method: "GET",
      url: `https://${domain}/.well-known/poppy.json`,
    })
  ).body as {
    organization: { domain: string };
    auth: { issuer: string };
    agent: { protocols: { type: string; endpoint: string }[] };
  };
  if (doc.organization.domain.replace(/^www\./, "") !== domain)
    throw new Error("poppy.json speaks for another domain");
  const meta = (
    await call(record, {
      label: "Check its OAuth server",
      method: "GET",
      url: `${doc.auth.issuer}/.well-known/oauth-authorization-server`,
    })
  ).body as Record<string, string | string[]>;
  if (
    meta.issuer !== doc.auth.issuer ||
    !(meta.poppy_domains as string[]).includes(domain)
  )
    throw new Error("the OAuth server does not vouch for this domain");
  const endpoint = doc.agent.protocols.find(
    (p) => p.type === "poppy",
  )?.endpoint;
  if (!endpoint) throw new Error("Flight Sector has no poppy conversations");
  return {
    domain,
    issuer: meta.issuer as string,
    tokenEndpoint: meta.token_endpoint as string,
    authorizationEndpoint: meta.authorization_endpoint as string,
    revocationEndpoint: meta.revocation_endpoint as string,
    conversations: endpoint,
  };
}

async function clientAuth(company: Company) {
  return {
    client_id: CLIENT_ID,
    client_assertion_type:
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: await assertion(company.tokenEndpoint),
  };
}

function keep(key: KeyPair, body: Record<string, unknown>): Session {
  if (typeof body.access_token !== "string")
    throw new Error(
      `Flight Sector refused: ${String(body.error ?? "no token")}`,
    );
  return {
    id: String(body.session_id),
    token: body.access_token,
    scopes: String(body.scope ?? "")
      .split(" ")
      .filter(Boolean),
    key,
  };
}

/** A signed-out Session: Atlas names itself and Sam's User ID, nothing more (spec §4.2). */
async function startSession(company: Company) {
  const key = await newKeyPair();
  const { body } = await call(record, {
    label: "Start a signed-out Session",
    method: "POST",
    url: company.tokenEndpoint,
    form: {
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: await assertion(company.tokenEndpoint, demo().userId),
      ...(await clientAuth(company)),
    },
    dpop: { key },
  });
  demo().session = keep(key, body);
}

type Read = {
  conversation_id: string;
  cursor: string;
  events: {
    type: string;
    error?: string;
    scope?: string;
    message?: { role: string; text?: string; data?: Record<string, unknown> };
  }[];
};

/** Say something to Flight Sector's agent and read what comes back (spec §7.3, §7.5). */
async function tell(
  text: string,
  label: string,
  data?: Record<string, unknown>,
) {
  const d = demo();
  const company = d.company!;
  const session = d.session!;
  const message = {
    id: `msg_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    sender: "agent",
    text,
    ...(data && { data }),
    ...(!d.conversation && {
      context: {
        locale: "en-US",
        time_zone: "America/Los_Angeles",
        user_available: true,
      },
    }),
  };
  const url = d.conversation
    ? `${company.conversations}/${d.conversation.id}/messages?${d.conversation.cursor ? `cursor=${d.conversation.cursor}&` : ""}wait=10`
    : `${company.conversations}?wait=10`;
  const { body } = await call(record, {
    label,
    method: "POST",
    url,
    json: { message },
    dpop: { key: session.key, token: session.token },
  });
  const read = body as Read;
  d.conversation = { id: read.conversation_id, cursor: read.cursor };
  let authorization: { error: string; scope?: string } | undefined;
  for (const event of read.events) {
    if (event.type === "message" && event.message) {
      const from = event.message.role === "company" ? "Flight Sector" : "Atlas";
      d.seen.push({
        from,
        text: event.message.text ?? "",
        data: event.message.data,
      });
      if (
        from === "Flight Sector" &&
        Array.isArray(event.message.data?.options)
      )
        d.options = event.message.data.options as Option[];
      if (from === "Flight Sector" && event.message.data?.booking_reference)
        d.result = Object.fromEntries(
          Object.entries(event.message.data).map(([k, v]) => [k, String(v)]),
        );
    }
    if (event.type === "authorization") {
      authorization = { error: event.error!, scope: event.scope };
      d.seen.push({
        from: "Flight Sector",
        text: "",
        note: `authorization: ${event.error}${event.scope ? ` (${event.scope})` : ""}`,
      });
    }
  }
  return authorization;
}

async function signInUrl(company: Company, scope: string) {
  const verifier = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url.encode(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
  const state = base64url.encode(crypto.getRandomValues(new Uint8Array(12)));
  demo().pending = { state, verifier, scope };
  const url = new URL(company.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

async function guarded(run: () => Promise<void>) {
  try {
    demo().error = undefined;
    await run();
  } catch (err) {
    demo().error = err instanceof Error ? err.message : String(err);
  }
}

/** Sam asks; Atlas finds Flight Sector, starts a signed-out Session, and opens the conversation. */
export async function ask() {
  await guarded(async () => {
    const d = demo();
    if (d.step !== "start") return;
    d.chat.push({ from: "sam", text: SAM_ASKS });
    d.chat.push({
      from: "atlas",
      text: "I'll ask Flight Sector about a sooner flight.",
    });
    d.company = await discover();
    await startSession(d.company);
    const needed = await tell(
      "The user's flight QF74 to Sydney is delayed six hours. They need to land before their 9am meeting on the 20th.",
      "Open a conversation",
    );
    if (!needed) throw new Error("expected Flight Sector to ask for sign-in");
    d.step = "sign-in";
    d.chat.push({
      from: "atlas",
      text: "Flight Sector needs you to sign in so they can find your booking.",
      signIn: await signInUrl(
        d.company,
        needed.scope ?? "poppy:read poppy:write",
      ),
    });
  });
}

/** The browser is back from Flight Sector: exchange the code for this Session (spec §4.5). */
export async function signedIn(query: URLSearchParams) {
  await guarded(async () => {
    const d = demo();
    const pending = d.pending;
    const company = d.company;
    if (!pending || !company || d.step !== "sign-in")
      throw new Error("no sign-in in progress");
    if (query.get("state") !== pending.state)
      throw new Error("sign-in state does not match");
    if (query.get("iss") !== company.issuer)
      throw new Error("sign-in came back from another issuer");
    if (query.get("error")) {
      d.chat.push({
        from: "atlas",
        text: "You didn't sign in, so I can't change the booking.",
      });
      return;
    }
    d.pending = undefined;
    const key = d.session!.key;
    const { body } = await call(record, {
      label: "Finish Direct Sign-In",
      method: "POST",
      url: company.tokenEndpoint,
      form: {
        grant_type: "authorization_code",
        code: query.get("code") ?? "",
        redirect_uri: REDIRECT_URI,
        code_verifier: pending.verifier,
        session_id: d.session!.id,
        ...(await clientAuth(company)),
      },
      dpop: { key },
    });
    d.session = keep(key, body);
    d.accountToken = String(body.refresh_token);
    d.chat.push({ from: "sam", text: "I'm signed in." });
    d.chat.push({
      from: "atlas",
      text: "Thanks. I'll check your booking now.",
    });
    await tell("The user has signed in.", "Continue the conversation");
    const options = d.options ?? [];
    const label = (o: Option) =>
      `${o.flight}, landing ${o.arrives}${o.fare_difference ? `, $${o.fare_difference} more` : ", no extra cost"}`;
    d.step = "choose";
    d.chat.push({
      from: "atlas",
      text: `Flight Sector can move you to ${options.map(label).join(", or ")}. Which would you like?`,
      choices: options.map((o) => ({ id: o.id, label: o.flight })),
    });
  });
}

/** Sam picks a flight; Atlas passes it on and closes the conversation (spec §7.12). */
export async function choose(optionId: string) {
  await guarded(async () => {
    const d = demo();
    const option = d.options?.find((o) => o.id === optionId);
    if (d.step !== "choose" || !option) throw new Error("nothing to choose");
    d.chat.push({ from: "sam", text: `${option.flight}, please.` });
    await tell(
      `The user would like ${option.flight}.`,
      "Pass on Sam's choice",
      { option: option.id },
    );
    if (!d.result) throw new Error("Flight Sector did not confirm the change");
    await call(record, {
      label: "Close the conversation",
      method: "POST",
      url: `${d.company!.conversations}/${d.conversation!.id}/close`,
      json: {},
      dpop: { key: d.session!.key, token: d.session!.token },
    });
    d.result.conversation = "closed";
    d.step = "done";
    d.chat.push({
      from: "atlas",
      text: `Done. You're on ${d.result.flight}, seat ${d.result.seat}, and Flight Sector emailed your new itinerary.`,
    });
  });
}

/** Sam takes Atlas's access away: the Account Token is revoked (spec §4.9). */
export async function disconnect() {
  await guarded(async () => {
    const d = demo();
    if (!d.accountToken || !d.company) throw new Error("not connected");
    await call(record, {
      label: "Disconnect from Flight Sector",
      method: "POST",
      url: d.company.revocationEndpoint,
      form: {
        token: d.accountToken,
        token_type_hint: "refresh_token",
        ...(await clientAuth(d.company)),
      },
    });
    d.accountToken = undefined;
    d.step = "disconnected";
    d.chat.push({
      from: "atlas",
      text: "I've disconnected from your Flight Sector account.",
    });
  });
}
