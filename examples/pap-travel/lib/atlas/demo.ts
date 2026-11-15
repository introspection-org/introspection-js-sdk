/**
 * Atlas, Sam's Personal Agent. Its own lines are scripted, but everything it
 * does at Flight Sector is real Poppy: discovery (spec 3), Direct Sign-In (4),
 * a Session header on every request (5), a conversation with Flight Sector's
 * Company Agent (8), which is the travel-agent recipe on Introspection, and
 * Operations v2 for terms Sam approves here. Atlas relays Sam's words and the
 * agent's replies; it reads the conversation in the background while the
 * agent works. The page reads `snapshot()`.
 */
import "server-only";

import {
  reset as resetRun,
  snapshot as runSnapshot,
} from "introspection-example-travel-demo-flow/demo/run";
import { startRecording } from "introspection-example-travel-demo-flow/demo/wire";

import { random, sha256 } from "../crypto";
import { once } from "../once";
import { ATLAS_URL, COMPANY_URL } from "../origins";
import { CLIENT_ID, clientAssertion, REDIRECT_URI } from "./identity";
import { type Answer, type Call, call, discover, record } from "./wire";

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
  /** Where the terms differ from what Sam holds, as Atlas reads them. */
  mismatch?: string;
  answer?: "approved" | "declined";
};

type ChatLine = {
  from: "Sam" | "Atlas";
  text: string;
  signIn?: string;
  approval?: ApprovalCard;
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

type Step = "start" | "sign-in" | "talking" | "approve" | "disconnected";

type Demo = {
  step: Step;
  chat: ChatLine[];
  company?: Company;
  /** Sam's User ID at Flight Sector: random, and not derived from anything about Sam (spec 5.1). */
  userId: string;
  sid?: string;
  tokens?: { access: string; refresh: string; scopes: string[] };
  conversation?: { id: string; cursor?: string; handled: Set<string> };
  pending?: { state: string; verifier: string };
  /** What Sam first asked, which Atlas opens the conversation with once signed in. */
  asked?: string;
  /** The last approval Atlas sent, kept to retry it as it was. */
  sentApproval?: Record<string, unknown>;
  /** Atlas is reading the conversation while Flight Sector's agent works. */
  reading: boolean;
  /** Bumped on reset, so a stale reader stops. */
  epoch: number;
  error?: string;
};

const fresh = (epoch = 0): Demo => ({
  step: "start",
  chat: [],
  userId: `usr_${random(12)}`,
  reading: false,
  epoch,
});

const store = once("atlas_demo", () => ({ demo: fresh() }));
const demo = () => store.demo;

/** The booking Sam holds, which Atlas knows as his assistant: three days out, so never in the past. */
function sams() {
  const day = new Date();
  day.setDate(day.getDate() + 3);
  const meeting = new Date(day);
  meeting.setDate(meeting.getDate() + 2);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const spoken = (d: Date) =>
    d.toLocaleDateString("en-GB", { day: "numeric", month: "long" });
  return {
    booking: {
      reference: "FS-8Q2M",
      flight: "QF74",
      from: "SFO",
      to: "SYD",
      date: iso(day),
      cabin: "economy",
      paid: { amount: "1650.00", currency: "USD" },
    },
    meeting: { date: iso(meeting), time: "09:00", spoken: spoken(meeting) },
    departs: spoken(day),
  };
}

/** The page's sample prompts, each with what to do next. */
export const SCENARIOS = [
  {
    id: "ua863",
    title: "UA863: no extra cost",
    prompt:
      "My QF74 to Sydney is delayed six hours and I have a 9am meeting when I land. Can you get me there in time without paying more?",
    hint: "Sign in at Flight Sector when Atlas asks. Its agent finds flights that land in time; pick the one at no extra cost, and Dana approves the trip at Acme behind the chat.",
  },
  {
    id: "qf8",
    title: "QF8: Sam approves the exact terms (Operations)",
    prompt:
      "My QF74 to Sydney is delayed six hours and I have a 9am meeting when I land. Get me there as early as you can, even if it costs more.",
    hint: "Sign in, then choose QF8 via Dallas. Flight Sector sends its exact terms for you to approve here, then Dana approves the trip's budget at Acme, and anything over it.",
  },
  {
    id: "declined",
    title: "QF8 declined: nothing changes",
    prompt:
      "My QF74 to Sydney is delayed six hours and I land after my 9am meeting. What are my options, and what do they cost?",
    hint: "Sign in, choose QF8 via Dallas, then decline its terms here. Nothing is booked, and the agent offers what costs no more.",
  },
];

export function snapshot() {
  const d = demo();
  const run = runSnapshot();
  return {
    step: d.step,
    prompt: d.chat.find((line) => line.from === "Sam")?.text,
    busy: d.reading,
    chat: d.chat,
    session: d.sid
      ? {
          sid: d.sid,
          signedIn: Boolean(d.tokens),
          scopes: d.tokens?.scopes ?? [],
          conversation: d.conversation?.id,
        }
      : undefined,
    error: d.error,
    // Behind the chat: Flight Sector's side, the task its agent runs on
    // Introspection, and Acme deciding for Sam's company.
    behind: {
      ...run,
      hosts: {
        ...run.hosts,
        "Flight Sector": new URL(COMPANY_URL).host,
        Atlas: new URL(ATLAS_URL).host,
      },
    },
  };
}

export function reset() {
  store.demo = fresh(demo().epoch + 1);
  resetRun();
  startRecording();
}

const sam = (text: string) => demo().chat.push({ from: "Sam", text });
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

const messageId = () => `msg_${random(12)}`;

/** Handles the events of a read, each once, in order, and keeps the cursor (8.5). */
async function heard(answer: Answer) {
  const d = demo();
  if (answer.status === 401) {
    const scope = answer.challenge?.match(/scope="([^"]+)"/)?.[1];
    return { needs: scope ?? "bookings:read bookings:write", idle: true };
  }
  if (answer.status >= 400)
    throw new Error(
      `Flight Sector refused: ${String(answer.body.error ?? answer.status)}`,
    );
  const read = answer.body as {
    conversation_id: string;
    cursor: string;
    status: string;
    events?: {
      id: string;
      type: string;
      scope?: string;
      message?: {
        role: string;
        text?: string;
        extensions?: { operations?: { operation?: Operation } };
      };
    }[];
  };
  d.conversation ??= { id: read.conversation_id, handled: new Set() };
  d.conversation.cursor = read.cursor ?? d.conversation.cursor;
  let needs: string | undefined;
  for (const event of read.events ?? []) {
    if (d.conversation.handled.has(event.id)) continue;
    d.conversation.handled.add(event.id);
    if (event.type === "authorization") needs = event.scope;
    const message = event.message;
    if (event.type !== "message" || message?.role !== "company") continue;
    const op = message.extensions?.operations?.operation;
    if (message.text)
      atlas({ text: `**${d.company!.name}:** ${message.text}` });
    if (op && d.company?.operations) askApproval(op);
  }
  if (needs)
    await askToSignIn(needs, "Flight Sector's agent needs more access.");
  return { needs, idle: read.status === "idle" };
}

/** Says something to Flight Sector's agent, then reads its replies until it is done (8.3, 8.5). */
async function tell(label: string, message: Record<string, unknown>) {
  const d = demo();
  const company = d.company!;
  const conversation = d.conversation;
  const query = `?${conversation?.cursor ? `cursor=${conversation.cursor}&` : ""}wait=2`;
  const url = conversation
    ? `${company.conversations}/${conversation.id}/messages${query}`
    : `${company.conversations}${query}`;
  const answer = await resource({
    label,
    method: "POST",
    url,
    json: { message: { id: message.id, ...message } },
  });
  const { idle } = await heard(answer);
  if (!idle && answer.status < 400) void readUntilIdle(d.epoch);
}

const READ_FOR_MS = 20 * 60 * 1000;

/**
 * Reads the conversation while the agent works, holding each read up to 25
 * seconds (8.5): a booking can wait minutes on Acme, and the agent's replies
 * arrive as it finishes them.
 */
async function readUntilIdle(epoch: number) {
  const d = demo();
  if (d.reading) return;
  d.reading = true;
  const until = Date.now() + READ_FOR_MS;
  try {
    while (demo().epoch === epoch && d.conversation && Date.now() < until) {
      const answer = await resource({
        label: "Read the conversation",
        method: "GET",
        url: `${d.company!.conversations}/${d.conversation.id}/events?${d.conversation.cursor ? `cursor=${d.conversation.cursor}&` : ""}wait=25`,
        quiet: true,
      });
      const { idle, needs } = await heard(answer);
      if (idle || needs || answer.status >= 400) break;
    }
  } catch (err) {
    if (demo().epoch === epoch)
      d.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (demo().epoch === epoch) d.reading = false;
  }
}

/** Checks the terms against the booking Sam holds, before Sam sees them (Operations 5). */
function mismatch(operation: Operation): string | undefined {
  const terms = operation.terms as
    { from?: string; to?: string; currency?: string } | undefined;
  const { booking } = sams();
  if (!terms) return undefined;
  const differences = [
    terms.from && terms.from !== booking.from && `it leaves from ${terms.from}`,
    terms.to && terms.to !== booking.to && `it flies to ${terms.to}`,
    terms.currency &&
      terms.currency !== booking.paid.currency &&
      `it is priced in ${terms.currency}`,
  ].filter(Boolean);
  return differences.length
    ? `These terms differ from the trip you hold: ${differences.join(", ")}.`
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
      mismatch: mismatch(operation),
    },
  });
}

/** Sam asks; Atlas finds Flight Sector, which works only with Sam's account, so Sam signs in first. */
async function ask(text: string) {
  const d = demo();
  sam(text);
  d.asked = text;
  startRecording();
  d.company = await find();
  // No request starts a Session: the first one with a new `sid` does (5).
  d.sid = newSid();
  const scopes =
    Object.keys(d.company.scopes).join(" ") || "bookings:read bookings:write";
  if (d.company.access === "signed_in")
    return askToSignIn(
      scopes,
      `${d.company.name}'s agent works with your ${d.company.name} account.`,
    );
  await open();
}

/** Opens the conversation with what Sam asked and the booking he holds. */
async function open() {
  const d = demo();
  const { booking, meeting, departs } = sams();
  d.step = "talking";
  atlas({ text: `I'll ask ${d.company!.name}'s agent.` });
  await tell("Start the conversation", {
    id: messageId(),
    author: { type: "agent" },
    text: `Sam's flight ${booking.flight} from San Francisco to Sydney on ${departs} is delayed six hours, so it lands after his 9am meeting on ${meeting.spoken}. Please find him a flight that lands in time. He asked me: "${d.asked}"`,
    data: { current_booking: booking, must_arrive_by: meeting },
    context: {
      locale: "en-US",
      time_zone: "America/Los_Angeles",
      user_available: true,
    },
  });
}

/** The browser is back from Flight Sector: exchange the code (spec 4.2), then talk to its agent. */
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
      d.step = "start";
      atlas({
        text: "You didn't sign in, so I can't ask Flight Sector's agent about your booking.",
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
    if (d.conversation) {
      d.step = "talking";
      await tell("Continue the conversation, signed in", {
        id: messageId(),
        author: { type: "agent" },
        text: "Sam has signed in again. Please go on.",
      });
    } else await open();
  });
}

/** Sam's own words, as he wrote them (8.8). */
async function relay(text: string) {
  sam(text);
  await tell("Pass on Sam's words", {
    id: messageId(),
    author: { type: "human" },
    text,
  });
}

/** Sam's answer to an operation, which Atlas sends only if Sam approved (Operations 5, 6). */
async function decide(verdict: "approve" | "decline") {
  const d = demo();
  const card = d.chat.findLast((line) => line.approval)?.approval;
  if (d.step !== "approve" || !card || card.answer)
    throw new Error("nothing to approve");
  card.answer = verdict === "approve" ? "approved" : "declined";
  d.step = "talking";
  const { operation_id, revision } = card.operation;
  if (verdict === "decline") {
    sam("Decline.");
    await tell("Say Sam declined", {
      id: messageId(),
      author: { type: "agent" },
      text: "Sam declined those terms. Please book nothing that costs more.",
    });
    return;
  }
  sam("Approve.");
  d.sentApproval = {
    id: messageId(),
    author: { type: "agent" },
    text: "Sam approved the change.",
    extensions: { operations: { approval: { operation_id, revision } } },
  };
  await tell("Send Sam's approval", d.sentApproval);
}

/**
 * Sends the approval again, as after a lost response: the same message, which
 * gets its original response, then a new message with the same approval,
 * which adds nothing. Flight Sector acts on it at most once (Operations 7).
 */
async function retryApproval() {
  const d = demo();
  if (!d.sentApproval || !d.conversation)
    throw new Error("no approval was sent");
  await heard(
    await resource({
      label: "Retry the approval: same message",
      method: "POST",
      url: `${d.company!.conversations}/${d.conversation.id}/messages?wait=0`,
      json: { message: d.sentApproval },
    }),
  );
  await heard(
    await resource({
      label: "Send the approval again: new message",
      method: "POST",
      url: `${d.company!.conversations}/${d.conversation.id}/messages?cursor=${d.conversation.cursor}&wait=0`,
      json: { message: { ...d.sentApproval, id: messageId() } },
    }),
  );
}

/** Sam signs Atlas out: close the conversation, revoke the refresh token (4.6), and carry on signed out (5.5). */
async function disconnect() {
  const d = demo();
  if (!d.tokens || !d.company) throw new Error("not signed in");
  sam("Disconnect from Flight Sector.");
  d.epoch += 1;
  d.reading = false;
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

/** Sam's typed message: the first starts it all; later ones go to Flight Sector's agent as Sam wrote them. */
export async function send(text: string) {
  await guarded(async () => {
    const d = demo();
    const lower = text.trim().toLowerCase();
    if (!lower) return;
    if (d.step === "start") return ask(text.trim());
    if (/^(disconnect|sign out|log out)\b/.test(lower) && d.tokens)
      return disconnect();
    if (d.step === "approve" && /^(approve|yes)\b/.test(lower))
      return decide("approve");
    if (d.step === "approve" && /^(decline|no)\b/.test(lower))
      return decide("decline");
    if (d.step === "sign-in") {
      sam(text.trim());
      atlas({ text: "Sign in at Flight Sector first, with the button above." });
      return;
    }
    if (d.step === "disconnected" || !d.tokens) {
      sam(text.trim());
      atlas({
        text: "I'm signed out of Flight Sector. Restart to begin again.",
      });
      return;
    }
    return relay(text.trim());
  });
}

/** The page's buttons. */
export async function act(action: string) {
  await guarded(async () => {
    if (action === "approve" || action === "decline") return decide(action);
    if (action === "retry-approval") return retryApproval();
    if (action === "disconnect") return disconnect();
    throw new Error(`unknown action ${action}`);
  });
}
