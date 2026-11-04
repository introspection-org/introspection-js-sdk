/**
 * Atlas, scripted: it understands only this story, and each step makes the
 * real Poppy requests to Flight Sector: discovery (spec 3), Sessions (5),
 * Direct Sign-In and revocation (4), conversations (8) and an operation the
 * user approves (Operations v2). The page reads `snapshot()`.
 */
import "server-only";

import { random, sha256 } from "../crypto";
import { records, resetRecords } from "../company/agent";
import { once } from "../once";
import { COMPANY_URL } from "../origins";
import { CLIENT_ID, clientAssertion, REDIRECT_URI } from "./identity";
import {
  type Answer,
  type Call,
  call,
  clearWire,
  discover,
  exchanges,
  record,
  setTurn,
} from "./wire";

type Option = {
  id: string;
  flight: string;
  arrives: string;
  fare_difference: number;
};

type Operation = {
  operation_id: string;
  revision: string;
  summary: string;
  terms?: Record<string, unknown>;
  expires_at: string;
};

/** What Atlas shows Sam to approve: the Company's name and its summary, in Atlas's own interface (Operations 5). */
type ApprovalCard = {
  company: string;
  operation: Operation;
  /** Where the terms differ from what Atlas asked for. */
  mismatch?: string;
  answer?: "approved" | "declined";
};

type ChatLine = {
  from: "Sam" | "Atlas";
  text: string;
  signIn?: string;
  choices?: { id: string; label: string }[];
  approval?: ApprovalCard;
};

/** One line of the conversation between the two agents, as Flight Sector sees it. */
type Seen = {
  turn: number;
  from: "Atlas" | "Flight Sector";
  text: string;
  note?: string;
};

type Company = {
  name: string;
  domain: string;
  issuer: string;
  tokenEndpoint: string;
  authorizationEndpoint: string;
  revocationEndpoint: string;
  conversations: string;
  access: "session" | "signed_in";
  operations: boolean;
  scopes: Record<string, string>;
  hints: Record<string, { changes: string; personal_data: boolean }>;
};

type Step =
  "start" | "sign-in" | "choose" | "approve" | "done" | "disconnected";

type Demo = {
  step: Step;
  chat: ChatLine[];
  seen: Seen[];
  company?: Company;
  /** Sam's User ID at Flight Sector: random, and not derived from anything about Sam (spec 5.1). */
  userId: string;
  sid?: string;
  tokens?: { access: string; refresh: string; scopes: string[] };
  conversation?: { id: string; cursor?: string; handled: Set<string> };
  pending?: { state: string; verifier: string };
  options?: Option[];
  asked?: Option;
  /** The last approval Atlas sent, kept to retry it as it was. */
  sentApproval?: Record<string, unknown>;
  error?: string;
};

const fresh = (): Demo => ({
  step: "start",
  chat: [],
  seen: [],
  userId: `usr_${random(12)}`,
});

const store = once("atlas_demo", () => ({ demo: fresh() }));
const demo = () => store.demo;

export const SAM_ASKS =
  "My QF74 to Sydney is delayed six hours, and I have a 9am meeting on the 20th. Can you get me there in time?";

export function snapshot() {
  const d = demo();
  return {
    step: d.step,
    chat: d.chat,
    seen: d.seen,
    exchanges: exchanges(),
    session: d.sid
      ? {
          sid: d.sid,
          signedIn: Boolean(d.tokens),
          scopes: d.tokens?.scopes ?? [],
          conversation: d.conversation?.id,
        }
      : undefined,
    records: records,
    error: d.error,
  };
}

export function reset() {
  store.demo = fresh();
  clearWire();
  resetRecords();
}

function sam(text: string) {
  const d = demo();
  d.chat.push({ from: "Sam", text });
  setTurn(d.chat.length - 1);
}
const atlas = (line: Omit<ChatLine, "from">) =>
  demo().chat.push({ from: "Atlas", ...line });

async function guarded(run: () => Promise<void>) {
  try {
    demo().error = undefined;
    await run();
  } catch (err) {
    demo().error = err instanceof Error ? err.message : String(err);
  }
}

/** RFC 8414 §3.1: the well-known segment goes before the issuer's path. */
const metadataUrl = (issuer: string) => {
  const url = new URL(issuer);
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.origin}/.well-known/oauth-authorization-server${path}`;
};

/**
 * Finds Flight Sector (spec 3): its poppy.json, which must speak for the host
 * that served it, its issuer from the domain's protected resource metadata,
 * and the issuer's metadata, which must list the domain.
 */
async function find(): Promise<Company> {
  const start = `https://${new URL(COMPANY_URL).hostname}/.well-known/poppy.json`;
  const found = await discover(
    "Find Flight Sector",
    start,
    "/.well-known/poppy.json",
  );
  const doc = found.body as {
    protocol_version: string;
    organization: { name: string; domain: string };
    auth?: {
      issuer?: string;
      disabled?: boolean;
      scopes?: Record<string, string>;
      scope_hints?: Company["hints"];
    };
    agent?: {
      protocols: { type: string; endpoint: string; access?: string }[];
    };
    extensions?: Record<string, { version?: string }>;
  };
  if (doc.protocol_version !== "0.3")
    throw new Error(`poppy.json is version ${doc.protocol_version}, not 0.3`);
  const domain = doc.organization.domain.toLowerCase();
  if (domain !== found.url.hostname.toLowerCase())
    throw new Error("poppy.json speaks for another domain");

  const resource = (
    await discover(
      "Find its issuer",
      `https://${domain}/.well-known/oauth-protected-resource`,
    )
  ).body as { resource?: string; authorization_servers?: string[] };
  if (resource.resource !== `https://${domain}`)
    throw new Error("the protected resource metadata is for another resource");
  const servers = resource.authorization_servers ?? [];
  const issuer =
    servers.length === 1
      ? servers[0]
      : servers.find((s) => s === doc.auth?.issuer);
  if (!issuer || (doc.auth?.issuer && doc.auth.issuer !== issuer))
    throw new Error("can't tell which issuer is Flight Sector's");

  const meta = (await discover("Check its OAuth server", metadataUrl(issuer)))
    .body as Record<string, string & string[]>;
  if (meta.issuer !== issuer)
    throw new Error("the OAuth server metadata names another issuer");
  const listed = (meta.protected_resources ?? []).map((r: string) => {
    const url = new URL(r);
    return `${url.protocol}//${url.host.toLowerCase()}${url.pathname === "/" ? "" : url.pathname}`;
  });
  if (!listed.includes(`https://${domain}`))
    throw new Error("the OAuth server doesn't vouch for this domain");
  if (
    doc.auth?.disabled ||
    !meta.grant_types_supported?.includes("authorization_code") ||
    !meta.grant_types_supported?.includes("refresh_token")
  )
    throw new Error("Flight Sector offers no Direct Sign-In");
  const poppy = doc.agent?.protocols.find((p) => p.type === "poppy");
  if (!poppy) throw new Error("Flight Sector has no Poppy conversations");
  return {
    name: doc.organization.name,
    domain,
    issuer,
    tokenEndpoint: meta.token_endpoint,
    authorizationEndpoint: meta.authorization_endpoint,
    revocationEndpoint: meta.revocation_endpoint,
    conversations: poppy.endpoint,
    access: poppy.access === "signed_in" ? "signed_in" : "session",
    operations: doc.extensions?.operations?.version === "2",
    scopes: doc.auth?.scopes ?? {},
    hints: doc.auth?.scope_hints ?? {},
  };
}

const newSid = () => random(16);

/**
 * A request to one of the Company's resources: always the Session header,
 * and the access token when signed in. A `session_ended` gets one retry in
 * a new Session (5.5), and an `invalid_token` one refresh (4.4).
 */
async function resource(spec: Call, signedIn = true): Promise<Answer> {
  const d = demo();
  const company = d.company!;
  const send = () =>
    call({
      ...spec,
      session: { aud: company.issuer, sid: d.sid!, sub: d.userId },
      accessToken: signedIn ? d.tokens?.access : undefined,
    });
  let answer = await send();
  if (answer.status === 400 && answer.body.error === "session_ended") {
    d.sid = newSid();
    answer = await send();
  } else if (
    answer.status === 401 &&
    answer.challenge?.includes("invalid_token") &&
    d.tokens &&
    (await refresh())
  )
    answer = await send();
  return answer;
}

async function clientAuth(company: Company) {
  return {
    client_id: CLIENT_ID,
    client_assertion_type:
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
    client_assertion: await clientAssertion(company.issuer),
  };
}

/** A new access token from the refresh token, or signed out if it no longer works. */
async function refresh(): Promise<boolean> {
  const d = demo();
  const { body } = await call({
    label: "Refresh the access token",
    method: "POST",
    url: d.company!.tokenEndpoint,
    form: {
      grant_type: "refresh_token",
      refresh_token: d.tokens!.refresh,
      ...(await clientAuth(d.company!)),
    },
  });
  if (typeof body.access_token !== "string") {
    d.tokens = undefined;
    return false;
  }
  d.tokens = {
    ...d.tokens!,
    access: body.access_token,
    refresh:
      typeof body.refresh_token === "string"
        ? body.refresh_token
        : d.tokens!.refresh,
  };
  return true;
}

type Heard = {
  /** The scopes an `authorization` event or a challenge asked for (8.11). */
  needs?: string;
  operation?: Operation;
  confirmed?: Record<string, unknown>;
  options?: Option[];
  status?: Record<string, string>;
};

const messageId = () => `msg_${random(12)}`;

/** Sends one message to Flight Sector's agent and reads what comes back with it (8.3, 8.5). */
async function tell(
  label: string,
  message: Record<string, unknown>,
): Promise<Heard> {
  const d = demo();
  const company = d.company!;
  const conversation = d.conversation;
  const query = `?${conversation?.cursor ? `cursor=${conversation.cursor}&` : ""}wait=10`;
  const url = conversation
    ? `${company.conversations}/${conversation.id}/messages${query}`
    : `${company.conversations}${query}`;
  const answer = await resource({
    label,
    method: "POST",
    url,
    json: {
      message: { id: message.id, author: { type: "agent" }, ...message },
    },
  });
  return heard(answer);
}

/** Handles the events in a response, each once, in order, and keeps the cursor (8.5). */
function heard(answer: Answer): Heard {
  const d = demo();
  const turn = d.chat.length - 1;
  const result: Heard = {};
  if (answer.status === 401) {
    result.needs = answer.challenge?.match(/scope="([^"]+)"/)?.[1] ?? "";
    return result;
  }
  if (answer.status >= 400)
    throw new Error(
      `Flight Sector refused: ${String(answer.body.error ?? answer.status)}`,
    );
  const read = answer.body as {
    conversation_id: string;
    cursor: string;
    events?: {
      id: string;
      type: string;
      scope?: string;
      message?: {
        role: string;
        text?: string;
        data?: Record<string, unknown>;
        extensions?: {
          operations?: { operation?: Operation; approval?: unknown };
        };
      };
    }[];
  };
  d.conversation ??= { id: read.conversation_id, handled: new Set() };
  d.conversation.cursor = read.cursor ?? d.conversation.cursor;
  for (const event of read.events ?? []) {
    if (d.conversation.handled.has(event.id)) continue;
    d.conversation.handled.add(event.id);
    if (event.type === "authorization") {
      result.needs = event.scope;
      d.seen.push({
        turn,
        from: "Flight Sector",
        text: "",
        note: `authorization · insufficient_scope · ${event.scope}`,
      });
    }
    const message = event.message;
    if (event.type !== "message" || !message) continue;
    const from = message.role === "company" ? "Flight Sector" : "Atlas";
    const op = message.extensions?.operations?.operation;
    d.seen.push({
      turn,
      from,
      text: message.text ?? "",
      note: op
        ? `operation ${op.operation_id} · revision ${op.revision}`
        : message.extensions?.operations?.approval
          ? "approval"
          : undefined,
    });
    if (from === "Atlas") continue;
    if (op && d.company?.operations) result.operation = op;
    const data = message.data ?? {};
    if (Array.isArray(data.options)) result.options = data.options as Option[];
    if (data.flight_status)
      result.status = data.flight_status as Record<string, string>;
    if (data.booking_reference && data.flight) result.confirmed = data;
  }
  return result;
}

/** The Direct Sign-In link for these scopes (spec 4.2). */
async function signInUrl(company: Company, scope: string) {
  const verifier = random(32);
  const state = random(12);
  demo().pending = { state, verifier };
  const url = new URL(company.authorizationEndpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope,
    state,
    code_challenge: await sha256(verifier),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

/** Asks Sam to sign in, saying what each scope allows, from Flight Sector's descriptions and hints (4.7). */
async function askToSignIn(scope: string, lead: string) {
  const d = demo();
  const company = d.company!;
  const lines = scope.split(" ").map((s) => {
    const hint = company.hints[s];
    const caution =
      hint && hint.changes !== "none"
        ? hint.changes === "reversible"
          ? " (changes can be undone)"
          : " (changes can't always be undone)"
        : "";
    return `- ${company.scopes[s] ?? s}${caution}`;
  });
  d.step = "sign-in";
  atlas({
    text: `${lead} To go on, ${company.name} needs you to sign in and let me:\n${lines.join("\n")}`,
    signIn: await signInUrl(company, scope),
  });
}

function offer(options: Option[]) {
  const d = demo();
  d.options = options;
  d.step = "choose";
  const label = (o: Option) =>
    `**${o.flight}**, landing ${o.arrives}, ${o.fare_difference ? `$${o.fare_difference} more` : "at no extra cost"}`;
  atlas({
    text: `You're on booking FS-8Q2M. ${d.company!.name} can move you to ${options.map(label).join(", or ")}. Which would you like?`,
    choices: options.map((o) => ({ id: o.id, label: o.flight })),
  });
}

function confirm(confirmed: Record<string, unknown>) {
  const d = demo();
  d.step = "done";
  atlas({
    text: `Done. You're on ${String(confirmed.flight)}, seat ${String(confirmed.seat)}, landing ${String(confirmed.arrives)}. ${d.company!.name} has emailed your new itinerary.`,
    choices: [{ id: "disconnect", label: "Disconnect from Flight Sector" }],
  });
}

/** Checks the terms against what Atlas asked for, before Sam sees them (Operations 5). */
function mismatch(operation: Operation, asked: Option): string | undefined {
  const terms = operation.terms as
    | {
        to_flight?: string;
        fare_difference?: { amount?: string; currency?: string };
      }
    | undefined;
  if (!terms) return undefined;
  const differences = [
    terms.to_flight !== asked.id && `the flight is ${terms.to_flight}`,
    Number(terms.fare_difference?.amount) !== asked.fare_difference &&
      `the fare difference is ${terms.fare_difference?.amount} ${terms.fare_difference?.currency}`,
  ].filter(Boolean);
  return differences.length
    ? `These terms differ from what I asked for: ${differences.join(", ")}.`
    : undefined;
}

function askApproval(operation: Operation) {
  const d = demo();
  d.step = "approve";
  atlas({
    text: `${d.company!.name} needs your approval before it makes this change. I'll only send it if you approve.`,
    approval: {
      company: d.company!.name,
      operation,
      mismatch: mismatch(operation, d.asked!),
    },
  });
}

/** What Atlas does with an answer to Sam's request: confirm, ask for approval, or ask to sign in. */
async function follow(result: Heard) {
  if (result.confirmed) return confirm(result.confirmed);
  if (result.operation) return askApproval(result.operation);
  if (result.needs !== undefined)
    return askToSignIn(
      result.needs || "bookings:read bookings:write",
      "Flight Sector needs more access first.",
    );
  if (result.options) return offer(result.options);
  atlas({ text: "Flight Sector didn't say. Want me to ask again?" });
}

/** Sam asks; Atlas finds Flight Sector, starts a signed-out Session, and opens a conversation. */
async function ask(text: string) {
  const d = demo();
  sam(text);
  d.company = await find();
  // No request starts a Session: the first one with a new `sid` does (5).
  d.sid = newSid();
  if (d.company.access === "signed_in")
    return askToSignIn(
      "bookings:read bookings:write",
      "Flight Sector works only with your account.",
    );
  const result = await tell("Start a conversation, signed out", {
    id: messageId(),
    text: "The user's flight QF74 to Sydney is delayed six hours. They need to land before their 9am meeting on Mon 20 Oct.",
    context: {
      locale: "en-US",
      time_zone: "America/Los_Angeles",
      user_available: true,
    },
  });
  const lead = result.status
    ? `QF74 now lands ${result.status.arrives}, after your meeting. UA863 and QF8 via Dallas both land before 9am.`
    : "Flight Sector can help.";
  if (result.needs !== undefined)
    return askToSignIn(result.needs || "bookings:read bookings:write", lead);
  return follow(result);
}

/** The browser is back from Flight Sector: exchange the code (spec 4.2) and continue the same conversation. */
export async function signedIn(query: URLSearchParams) {
  await guarded(async () => {
    const d = demo();
    const { pending, company } = d;
    if (!pending || !company || d.step !== "sign-in")
      throw new Error("no sign-in in progress");
    sam("Signed in at Flight Sector");
    record({
      from: "Sam's browser",
      to: "Atlas",
      label: "Back from Flight Sector",
      status: 303,
      request: `GET ${REDIRECT_URI}?${[...query]
        .map(([k, v]) => `${k}=${k === "code" ? `${v.slice(0, 10)}…` : v}`)
        .join("&")}`,
      response: "HTTP/1.1 303 See Other\nLocation: /",
    });
    if (query.get("state") !== pending.state)
      throw new Error("sign-in state does not match");
    if (query.get("iss") !== company.issuer)
      throw new Error("sign-in came back from another issuer");
    d.pending = undefined;
    if (query.get("error")) {
      d.step = "choose";
      atlas({
        text: "You didn't sign in, so I can't change the booking. I can still ask Flight Sector general questions.",
      });
      return;
    }
    const { body } = await call({
      label: "Finish Direct Sign-In",
      method: "POST",
      url: company.tokenEndpoint,
      form: {
        grant_type: "authorization_code",
        code: query.get("code") ?? "",
        redirect_uri: REDIRECT_URI,
        code_verifier: pending.verifier,
        ...(await clientAuth(company)),
      },
    });
    if (typeof body.access_token !== "string")
      throw new Error(`sign-in failed: ${String(body.error)}`);
    d.tokens = {
      access: body.access_token,
      refresh: String(body.refresh_token),
      scopes: String(body.scope ?? "")
        .split(" ")
        .filter(Boolean),
    };
    const result = await tell("Continue the conversation, signed in", {
      id: messageId(),
      text: "The user has signed in. Please find their booking.",
    });
    await follow(result);
  });
}

async function choose(option: Option) {
  const d = demo();
  sam(`${option.flight}, please.`);
  d.asked = option;
  await follow(
    await tell("Pass on Sam's choice", {
      id: messageId(),
      text: `The user would like ${option.flight}.`,
      data: { option: option.id },
    }),
  );
}

/** Sam's answer to an operation, which Atlas sends only if Sam approved (Operations 5, 6). */
async function decide(verdict: "approve" | "decline") {
  const d = demo();
  const card = d.chat.findLast((line) => line.approval)?.approval;
  if (d.step !== "approve" || !card || card.answer)
    throw new Error("nothing to approve");
  card.answer = verdict === "approve" ? "approved" : "declined";
  const { operation_id, revision } = card.operation;
  if (verdict === "decline") {
    sam("Decline.");
    await tell("Say Sam declined", {
      id: messageId(),
      text: "The user declined the change. Please leave the booking as it is.",
    });
    d.step = "choose";
    atlas({
      text: "I didn't change anything. UA863 is still there at no extra cost.",
      choices: (d.options ?? []).map((o) => ({ id: o.id, label: o.flight })),
    });
    return;
  }
  sam("Approve.");
  d.sentApproval = {
    id: messageId(),
    text: "The user approved the change.",
    extensions: { operations: { approval: { operation_id, revision } } },
  };
  await follow(await tell("Send Sam's approval", d.sentApproval));
}

/**
 * Sends the approval again, as after a lost response: the same message, which
 * gets its original response, then a new message with the same approval,
 * which adds nothing. Flight Sector changes the booking at most once (Operations 7).
 */
async function retryApproval() {
  const d = demo();
  if (!d.sentApproval) throw new Error("no approval was sent");
  setTurn(d.chat.length - 1);
  heard(
    await resource({
      label: "Retry the approval: same message",
      method: "POST",
      url: `${d.company!.conversations}/${d.conversation!.id}/messages?wait=10`,
      json: {
        message: {
          id: d.sentApproval.id,
          author: { type: "agent" },
          ...d.sentApproval,
        },
      },
    }),
  );
  await tell("Send the approval again: new message", {
    ...d.sentApproval,
    id: messageId(),
  });
}

/** Sam signs Atlas out: close the conversation, revoke the refresh token (4.6), and carry on signed out (5.5). */
async function disconnect() {
  const d = demo();
  if (!d.tokens || !d.company) throw new Error("not signed in");
  sam("Disconnect from Flight Sector.");
  if (d.conversation)
    await resource({
      label: "Close the conversation",
      method: "POST",
      url: `${d.company.conversations}/${d.conversation.id}/close`,
      json: {},
    });
  await call({
    label: "Sign out: revoke the refresh token",
    method: "POST",
    url: d.company.revocationEndpoint,
    form: {
      token: d.tokens.refresh,
      token_type_hint: "refresh_token",
      ...(await clientAuth(d.company)),
    },
  });
  d.tokens = undefined;
  d.step = "disconnected";
  if (d.conversation)
    await resource(
      {
        label: "Read the conversation, signed out",
        method: "GET",
        url: `${d.company.conversations}/${d.conversation.id}/events`,
      },
      false,
    );
  atlas({
    text: "I've signed out of your Flight Sector account. My Session there carries on signed out, so Flight Sector won't show me our conversation again unless you sign in.",
  });
}

/** Sam's typed message, as this scripted Atlas understands it. */
export async function send(text: string) {
  await guarded(async () => {
    const d = demo();
    const lower = text.toLowerCase();
    if (d.step === "start") return ask(text);
    if (/disconnect|sign out|log out/.test(lower) && d.tokens)
      return disconnect();
    if (d.step === "approve" && /^(approve|yes)/.test(lower))
      return decide("approve");
    if (d.step === "approve" && /^(decline|no)/.test(lower))
      return decide("decline");
    const option = d.options?.find(
      (o) =>
        lower.includes(o.id.toLowerCase()) ||
        (o.id === "QF8" && lower.includes("dallas")) ||
        (o.id === "UA863" && lower.includes("united")),
    );
    if (d.step === "choose" && option) return choose(option);
    sam(text);
    atlas({
      text:
        d.step === "sign-in"
          ? "Sign in at Flight Sector first, with the button above."
          : d.step === "choose"
            ? "Which one: UA863 or QF8 via Dallas?"
            : "That's all I can do in this demo. Restart to try the other flight.",
    });
  });
}

/** The page's buttons. */
export async function act(action: string, option?: string) {
  await guarded(async () => {
    const d = demo();
    if (action === "choose") {
      if (option === "disconnect") return disconnect();
      const picked = d.options?.find((o) => o.id === option);
      if (d.step !== "choose" || !picked) throw new Error("nothing to choose");
      return choose(picked);
    }
    if (action === "approve" || action === "decline") return decide(action);
    if (action === "retry-approval") return retryApproval();
    if (action === "disconnect") return disconnect();
    throw new Error(`unknown action ${action}`);
  });
}
