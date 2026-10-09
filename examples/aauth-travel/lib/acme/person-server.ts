/**
 * Acme's Person Server (AAuth -11, three-party): the service that speaks for
 * Acme's people when an agent wants to act for them. It exchanges a resource's
 * resource token for an auth token, under Acme's own travel policy: within the
 * city caps it issues one at once; over them it asks the traveller's manager,
 * by email with a six-digit code, and the agent polls a pending URL meanwhile.
 * In-memory and per process.
 */
import "server-only";

import {
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import {
  type JWK,
  type JWTPayload,
  createLocalJWKSet,
  decodeJwt,
  jwtVerify,
} from "jose";

import {
  AAuthError,
  TYP,
  TokenError,
  assertBound,
  now,
  problem,
  publicJwk,
  requirement,
  signatureError,
  thumbprint,
  verifySignature,
  verifyToken,
} from "../aauth";
import { record } from "../events";
import { BOOKING_ISSUER, PERSON_SERVER_URL } from "../origins";
import { personServerSigner } from "../signing";
import { companies, flights, hotels, people, type Person } from "../world";
import { sendApprovalEmail } from "./mail";

const PS = PERSON_SERVER_URL;
const PS_HOST = new URL(PS).host;
const TENANT = "acme";
const TOKEN_TTL_SECONDS = 60 * 60;
const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RETRY_AFTER_SECONDS = 5;
// Agent providers whose agents Acme lets act for its people: the platform's
// control plane locally, and the e2e script's test provider outside production.
const TRUSTED_AGENT_PROVIDERS = (
  process.env.TRUSTED_AGENT_PROVIDERS ||
  (process.env.NODE_ENV === "production"
    ? ""
    : "http://localhost:8000,http://localhost:3499")
)
  .split(",")
  .map((url) => url.trim().replace(/\/+$/, ""))
  .filter(Boolean);

// Resources Acme lets its people book with; fetching their keys is egress, so the list is closed.
const TRUSTED_RESOURCES = (process.env.ACME_TRUSTED_RESOURCES || BOOKING_ISSUER)
  .split(",")
  .map((url) => url.trim().replace(/\/+$/, ""))
  .filter(Boolean);

export const ENDPOINTS = {
  token: `${PS}/ps/token`,
  pending: (id: string) => `${PS}/ps/pending/${id}`,
};

export function personServerMetadata() {
  return {
    issuer: PS,
    name: "Acme Person Server",
    description:
      "Speaks for Acme's people. Acme's travel policy decides; managers approve exceptions.",
    jwks_uri: `${PS}/.well-known/jwks.json`,
    auth_token_endpoint: ENDPOINTS.token,
    accept_signature_algs: ["Ed25519", "ES256"],
  };
}

interface Agent {
  id: string;
  raw: string;
  exp: number;
  jkt: string;
  jwk: JWK;
}

interface Issued {
  aud: string;
}

interface Grant {
  aud: string;
  sub: string;
  scope: string;
  jwk: JWK;
  authorization_details?: unknown;
  /** No token issued under this grant may outlive it. */
  notAfter: number;
}

interface Pending {
  id: string;
  agent: string;
  jkt: string;
  person: Person;
  approver: Person;
  item: string;
  reasons: string[];
  grant: Grant;
  status: "pending" | "approved" | "denied" | "expired";
  result?: Record<string, unknown>;
  codeHash: string;
  expiresAt: number;
  attempts: number;
}

const state = ((
  globalThis as unknown as { __acmePersonServer?: object }
).__acmePersonServer ??= {
  secret: process.env.ACME_PS_SUBJECT_SECRET || randomBytes(32).toString("hex"),
  bindings: new Map(),
  issued: new Map(),
  pending: new Map(),
}) as {
  secret: string;
  bindings: Map<string, string>;
  issued: Map<string, Issued>;
  pending: Map<string, Pending>;
};

const pathOf = (url: string) => new URL(url).pathname;

function readBody(body: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed;
  } catch {
    // fall through
  }
  throw new AAuthError(400, "invalid_request", "body must be a JSON object");
}

// #region verify-agent
/**
 * Every endpoint is called by an agent, signing with its own key and
 * presenting its agent token. The token must come from an agent provider Acme
 * trusts, verified against that provider's published keys, and bind the key
 * that signed the request.
 */
async function verifyAgent(
  request: Request,
  body: string | undefined,
  endpoint: string,
): Promise<Agent> {
  const signed = await verifySignature(request, body, {
    authority: PS_HOST,
    path: pathOf(endpoint),
  });
  if (signed.keyType !== "jwt" || signed.jwt?.typ !== TYP.agent)
    throw signatureError("invalid_jwt", "present an agent token (sig=jwt)");
  const token = await verifyToken(signed.jwt.raw, {
    typ: TYP.agent,
    dwk: "aauth-agent.json",
    issuers: TRUSTED_AGENT_PROVIDERS,
  }).catch((err: Error) => {
    const expired = err instanceof TokenError && err.reason === "expired";
    throw signatureError(expired ? "expired_jwt" : "invalid_jwt", err.message);
  });
  await assertBound(token, signed);
  const id = String(token.sub);
  const domain = new URL(String(token.iss)).hostname;
  if (!/^aauth:[A-Za-z0-9_.-]{1,255}@/.test(id) || !id.endsWith(`@${domain}`))
    throw signatureError("invalid_jwt", `${id} is not an agent of ${domain}`);
  if (token.ps !== undefined && token.ps !== PS)
    throw new AAuthError(403, "invalid_request", "this agent's PS is another");
  return {
    id,
    raw: signed.jwt.raw,
    exp: Number(token.exp),
    jkt: signed.thumbprint,
    jwk: publicJwk(signed.publicKey),
  };
}

/**
 * Acme pre-authorizes the agent providers it trusts for its people, and binds
 * each agent key to the one employee its first request names in
 * `login_hint`. That key can never act for anyone else.
 */
function personFor(agent: Agent, loginHint?: unknown): Person {
  const hinted =
    typeof loginHint === "string"
      ? people.find(
          (p) =>
            p.company === TENANT &&
            (p.external_user_id === loginHint || p.email === loginHint),
        )
      : undefined;
  if (loginHint !== undefined && !hinted)
    throw new AAuthError(400, "invalid_request", "not an Acme employee");
  const bound = state.bindings.get(agent.jkt);
  if (bound) {
    if (hinted && hinted.external_user_id !== bound)
      throw new AAuthError(403, "invalid_request", "bound to another person");
    return people.find((p) => p.external_user_id === bound)!;
  }
  if (!hinted)
    throw new AAuthError(400, "invalid_request", "name the person: login_hint");
  state.bindings.set(agent.jkt, hinted.external_user_id);
  return hinted;
}
// #endregion

/** The person's directed identifier at one audience: no two audiences can correlate it. */
const directed = (person: Person, audience: string) =>
  createHmac("sha256", state.secret)
    .update(`${person.external_user_id}\n${audience}`)
    .digest("base64url");

// #region auth-token
/**
 * The agent brings the resource token it got from the booking provider, and
 * the agent token it presented there. Acme checks the two belong together and
 * name this agent's key, then applies its travel policy to the booking the
 * resource token describes.
 */
export async function authToken(request: Request): Promise<Response> {
  const body = await request.text();
  const agent = await verifyAgent(request, body, ENDPOINTS.token);
  const params = readBody(body);
  const rt = await verifyTokenRequest(agent, params);
  const person = personFor(agent, params.login_hint);
  const grant: Grant = {
    aud: String(rt.iss),
    sub: directed(person, String(rt.iss)),
    scope: String(rt.scope ?? ""),
    jwk: agent.jwk,
    ...(rt.authorization_details
      ? { authorization_details: rt.authorization_details }
      : {}),
    notAfter: agent.exp,
  };
  const reasons = overPolicy(person, rt.authorization_details);
  record(
    "acme.policy_checked",
    reasons.length ? reasons.join("; ") : "within Acme's policy",
    {
      within: reasons.length === 0,
    },
  );
  if (reasons.length === 0) return Response.json(await issueAuthToken(grant));
  return askApprover({
    agent,
    person,
    grant,
    reasons,
    item: describe(rt.authorization_details),
  });
}

/**
 * -11 resource token verification. The resource token names this Person
 * Server and the agent's key, and the presented token is the agent token this
 * request was signed with.
 */
async function verifyTokenRequest(
  agent: Agent,
  params: Record<string, unknown>,
): Promise<JWTPayload> {
  const { resource_token, presented_token } = params;
  if (typeof resource_token !== "string" || typeof presented_token !== "string")
    throw new AAuthError(
      400,
      "invalid_request",
      "resource_token and presented_token are required",
    );
  const invalid = (detail: string) =>
    new AAuthError(400, "invalid_resource_token", detail);
  let issuer: unknown;
  try {
    issuer = decodeJwt(resource_token).iss;
  } catch {
    throw invalid("not a JWT");
  }
  if (!TRUSTED_RESOURCES.includes(String(issuer)))
    throw invalid(`${String(issuer)} is not a resource Acme books with`);
  const rt = await verifyToken(resource_token, {
    typ: TYP.resource,
    dwk: "aauth-resource.json",
    issuers: TRUSTED_RESOURCES,
  }).catch((err: Error) => {
    const expired = err instanceof TokenError && err.reason === "expired";
    throw new AAuthError(
      400,
      expired ? "expired_resource_token" : "invalid_resource_token",
      err.message,
    );
  });
  if (rt.aud !== PS) throw invalid("aud is not this Person Server");
  if (rt.agent_jkt !== agent.jkt) throw invalid("agent_jkt is not the signer");
  if (!(await presentedByAgent(agent, presented_token)))
    throw new AAuthError(
      400,
      "invalid_presented_token",
      "the presented token is not this agent's",
    );
  if (rt.presented_jti !== decodeJwt(presented_token).jti)
    throw invalid("presented_jti does not match");
  return rt;
}

/**
 * The token the agent showed the resource: its own agent token, or an auth
 * token Acme issued to this same key earlier (a step-up for another quote).
 */
async function presentedByAgent(
  agent: Agent,
  presented: string,
): Promise<boolean> {
  if (presented === agent.raw) return true;
  const { payload } = await jwtVerify(
    presented,
    createLocalJWKSet((await personServerSigner()).jwks),
    { issuer: PS, typ: TYP.auth },
  ).catch(() => ({ payload: undefined }));
  const jwk = (payload?.cnf as { jwk?: JWK } | undefined)?.jwk;
  return (
    !!payload &&
    state.issued.has(String(payload.jti)) &&
    !!jwk &&
    (await thumbprint(jwk)) === agent.jkt
  );
}
// #endregion

// #region policy
/**
 * Acme's travel policy, applied to the provider-signed quote. A personal leg
 * Acme doesn't pay for is the traveller's business; a business booking over
 * the city's caps needs the traveller's manager.
 */
function overPolicy(person: Person, details: unknown): string[] {
  const booking = (Array.isArray(details) ? details : []).find(
    (d) => d?.type === "booking",
  );
  if (!booking) return ["the booking is not described"];
  if (booking.payer === "traveler") return [];
  let offer: JWTPayload;
  try {
    offer = decodeJwt(String(booking.quote));
  } catch {
    return ["the quote is unreadable"];
  }
  const company = companies[person.company];
  const zone = company?.zones[String(offer.city ?? offer.to ?? "")];
  if (!zone)
    return [`${company?.name ?? "the company"} has no policy for that city`];
  const dollars = (cents: number) => `$${Math.round(cents / 100)}`;
  const reasons: string[] = [];
  if (
    offer.nightly_cents &&
    Number(offer.nightly_cents) > zone.hotel_nightly_cap_cents
  )
    reasons.push(
      `${dollars(Number(offer.nightly_cents))}/night is over ${company.name}'s ${dollars(zone.hotel_nightly_cap_cents)} cap for ${String(offer.city)}`,
    );
  if (!offer.nightly_cents && Number(offer.total_cents) > zone.flight_cap_cents)
    reasons.push(
      `${dollars(Number(offer.total_cents))} is over ${company.name}'s ${dollars(zone.flight_cap_cents)} flight cap`,
    );
  return reasons;
}
// #endregion

async function issueAuthToken(
  grant: Grant,
): Promise<{ auth_token: string; expires_in: number }> {
  const iat = now();
  const exp = Math.min(iat + TOKEN_TTL_SECONDS, grant.notAfter);
  const jti = randomUUID();
  const token = await (
    await personServerSigner()
  ).sign(
    {
      iss: PS,
      dwk: "aauth-person.json",
      aud: grant.aud,
      ps: PS,
      sub: grant.sub,
      cnf: { jwk: grant.jwk },
      scope: grant.scope,
      tenant: TENANT,
      ...(grant.authorization_details
        ? { authorization_details: grant.authorization_details }
        : {}),
      jti,
      iat,
      exp,
    },
    TYP.auth,
  );
  state.issued.set(jti, { aud: grant.aud });
  record("acme.auth_token_issued", `auth token for ${grant.aud}`, {
    jti,
    scope: grant.scope,
  });
  return { auth_token: token, expires_in: exp - iat };
}

const hash = (code: string) => createHash("sha256").update(code).digest();

// #region ask
/**
 * Over policy, a person decides. Who that is, and how to reach them, is Acme's
 * business: the traveller's manager from Acme's directory, by email, with a
 * six-digit code. The agent gets a pending URL to poll.
 */
async function askApprover(ask: {
  agent: Agent;
  person: Person;
  grant: Grant;
  reasons: string[];
  item: string;
}): Promise<Response> {
  const { person } = ask;
  const approver = people.find((p) => p.external_user_id === person.manager);
  if (!approver)
    throw new AAuthError(
      403,
      "user_unreachable",
      `${person.name} has no manager`,
    );
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const pending: Pending = {
    id: randomUUID(),
    agent: ask.agent.id,
    jkt: ask.agent.jkt,
    person,
    approver,
    item: ask.item,
    reasons: ask.reasons,
    grant: ask.grant,
    status: "pending",
    codeHash: hash(code).toString("hex"),
    expiresAt: Date.now() + CODE_TTL_MS,
    attempts: 0,
  };
  state.pending.set(pending.id, pending);
  await sendApprovalEmail({
    to: approver.email,
    approverName: approver.name,
    travellerName: person.name,
    item: pending.item,
    reasons: pending.reasons,
    link: `${PS}/approve/${pending.id}`,
    code,
  });
  record("acme.approval_requested", `asked ${approver.name} by email`, {
    pending: pending.id,
  });
  return stillPending(pending);
}
// #endregion

const stillPending = (pending: Pending) =>
  Response.json(
    { status: "pending" },
    {
      status: 202,
      headers: {
        Location: ENDPOINTS.pending(pending.id),
        "Retry-After": String(RETRY_AFTER_SECONDS),
        "Cache-Control": "no-store",
        "AAuth-Requirement": requirement("approval"),
      },
    },
  );

// #region pending
/** The agent polls with a signed GET; only the agent that asked may read it. */
export async function pendingState(
  request: Request,
  id: string,
): Promise<Response> {
  const agent = await verifyAgent(request, undefined, ENDPOINTS.pending(id));
  const pending = state.pending.get(id);
  if (!pending || pending.jkt !== agent.jkt)
    return problem(404, "not_found", "no such pending request");
  if (pending.status === "pending" && Date.now() > pending.expiresAt)
    pending.status = "expired";
  switch (pending.status) {
    case "pending":
      return stillPending(pending);
    case "approved":
      return Response.json(pending.result);
    case "denied":
      return problem(403, "denied", `${pending.approver.name} declined`);
    default:
      return problem(408, "expired", "nobody answered in time");
  }
}
// #endregion

// #region decide
/** The approver's answer from Acme's page, proven by the code Acme emailed. */
export async function decide(
  id: string,
  code: string,
  verdict: "approve" | "decline",
) {
  const pending = state.pending.get(id);
  if (!pending) throw new AAuthError(404, "not_found", "no such request");
  if (pending.status !== "pending")
    throw new AAuthError(409, "invalid_request", `already ${pending.status}`);
  if (pending.attempts >= MAX_ATTEMPTS || Date.now() > pending.expiresAt)
    throw new AAuthError(410, "invalid_code", "this code has expired");
  pending.attempts += 1;
  const expected = Buffer.from(pending.codeHash, "hex");
  if (!/^\d{6}$/.test(code) || !timingSafeEqual(hash(code), expected))
    throw new AAuthError(401, "invalid_code", "that code isn't right");

  if (verdict === "decline") {
    pending.status = "denied";
  } else {
    pending.result = await issueAuthToken(pending.grant);
    pending.status = "approved";
  }
  record("acme.decided", `${pending.approver.name} ${pending.status}`, {
    pending: id,
    status: pending.status,
  });
  return { status: pending.status };
}
// #endregion

/** What the approval page shows. */
export function approvalSummary(id: string) {
  const pending = state.pending.get(id);
  if (!pending) return null;
  return {
    status: pending.status,
    company: companies.acme.name,
    traveller: pending.person.name,
    approver: pending.approver.name,
    sentTo: maskEmail(pending.approver.email),
    item: pending.item,
    reasons: pending.reasons,
  };
}

/** The booking a resource token's authorization details describe, from its quote. */
function describe(details: unknown): string {
  const booking = (Array.isArray(details) ? details : []).find(
    (d) => d?.type === "booking",
  );
  if (!booking) return "an action at a resource";
  let offer: JWTPayload;
  try {
    offer = decodeJwt(String(booking.quote));
  } catch {
    return String(booking.offer_id);
  }
  const dollars = (cents: unknown) =>
    `$${Math.round(Number(cents) / 100).toLocaleString("en-US")}`;
  const [kind, id] = String(offer.offer_id).split(":");
  const title =
    kind === "ht"
      ? (hotels.find((h) => h.id === id)?.name ?? String(offer.offer_id))
      : (flights.find((f) => f.id === id)?.flight ?? String(offer.offer_id));
  const what = offer.nightly_cents
    ? `${title} at ${dollars(offer.nightly_cents)}/night (${dollars(offer.total_cents)} total)`
    : `${title}${offer.cabin ? `, ${offer.cabin}` : ""}, ${dollars(offer.total_cents)}`;
  return `${what}, ${booking.purpose}, paid by ${booking.payer}`;
}

function maskEmail(email: string): string {
  const [user = "", domain = ""] = email.split("@");
  return `${user.slice(0, 1)}•••@${domain}`;
}
