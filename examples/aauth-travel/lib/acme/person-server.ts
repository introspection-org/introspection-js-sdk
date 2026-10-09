/**
 * Acme's Person Server (AAuth -11, three-party): it speaks for Acme's people
 * when an agent wants to act for them. Acme's policy is short. A trip is a
 * mission, and the traveller's manager approves it once, budget and all; each
 * booking under it is then authorized at once while it stays within budget.
 * Anything over goes back to the manager. Everything is in memory.
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

import { fetch as signedFetch } from "@hellocoop/httpsig";
import { verifyR3Hash, type R3Document } from "@aauth/resource";
import {
  type JWK,
  type JWTPayload,
  createLocalJWKSet,
  decodeJwt,
  jwtVerify,
} from "jose";

import {
  AAuthError,
  now,
  problem,
  s256,
  signatureError,
  verifyIssued,
  verifyPresented,
  verifySignature,
} from "../aauth";
import { record } from "../events";
import { AGENT_PROVIDERS, BOOKING_ISSUER, PERSON_SERVER_URL } from "../origins";
import { personServerSigner } from "../signing";
import { people, type Person } from "../world";
import { sendApprovalEmail } from "./mail";

const PS = PERSON_SERVER_URL;
const DWK = "aauth-person.json";
const TENANT = "acme";
const TOKEN_TTL_SECONDS = 60 * 60;
const MISSION_TTL_SECONDS = 14 * 24 * 60 * 60;
const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const RETRY_AFTER_SECONDS = 5;
// Resources Acme lets its people use. Fetching their keys is egress, so the list is closed.
const RESOURCES = (process.env.ACME_TRUSTED_RESOURCES || BOOKING_ISSUER)
  .split(",")
  .map((url) => url.trim().replace(/\/+$/, ""))
  .filter(Boolean);

export const ENDPOINTS = {
  personToken: `${PS}/ps/person-token`,
  token: `${PS}/ps/token`,
  mission: `${PS}/ps/mission`,
  pending: (id: string) => `${PS}/ps/pending/${id}`,
};

export function personServerMetadata() {
  return {
    issuer: PS,
    name: "Acme Person Server",
    description:
      "Speaks for Acme's people. A manager approves each trip as a mission; bookings within it need no one.",
    jwks_uri: `${PS}/.well-known/jwks.json`,
    person_token_endpoint: ENDPOINTS.personToken,
    auth_token_endpoint: ENDPOINTS.token,
    mission_endpoint: ENDPOINTS.mission,
  };
}

interface Agent {
  id: string;
  exp: number;
  jkt: string;
  jwk: JWK;
}

interface Mission {
  s256: string;
  /** The blob's bytes, as hashed and returned. */
  bytes: string;
  agent: string;
  person: Person;
  resources: string[];
  budget_cents: number;
  spent_cents: number;
  expires_at: number;
  terminated?: string;
  log: { at: string; entry: string }[];
}

interface Pending {
  id: string;
  jkt: string;
  approver: Person;
  person: Person;
  item: string;
  reasons: string[];
  /** What approval grants: the response the agent's next poll gets. */
  onApprove: () => Promise<Record<string, unknown>>;
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
  missions: new Map(),
  pending: new Map(),
}) as {
  secret: string;
  bindings: Map<string, string>;
  missions: Map<string, Mission>;
  pending: Map<string, Pending>;
};

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
 * presenting its agent token, from an agent provider Acme trusts.
 */
async function verifyAgent(
  request: Request,
  body: string | undefined,
  url: string,
): Promise<Agent> {
  const signed = await verifySignature(request, body, url);
  const token = await verifyPresented(signed, {
    audience: PS,
    accept: ["agent"],
    issuers: { agent: AGENT_PROVIDERS },
  });
  if (token.type !== "agent")
    throw signatureError("invalid_jwt", "present an agent token");
  if (token.ps !== undefined && token.ps !== PS)
    throw new AAuthError(
      403,
      "invalid_request",
      "this agent's Person Server is another",
    );
  return {
    id: token.sub,
    exp: token.exp,
    jkt: signed.thumbprint,
    jwk: token.cnf.jwk,
  };
}

/**
 * Acme binds each agent key to the one employee its first request names in
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

async function issue(
  typ: string,
  claims: Record<string, unknown>,
  notAfter: number,
) {
  const iat = now();
  const exp = Math.min(iat + TOKEN_TTL_SECONDS, notAfter);
  const signer = await personServerSigner();
  const token = await signer.sign(
    {
      iss: PS,
      dwk: DWK,
      tenant: TENANT,
      jti: randomUUID(),
      iat,
      exp,
      ...claims,
    },
    typ,
  );
  return { token, expires_in: exp - iat };
}

const dollars = (cents: number) =>
  `$${Math.round(cents / 100).toLocaleString("en-US")}`;

// #region missions
/** The live mission `s256` names, if it is this agent's; the same 404 otherwise (no probing). */
function missionOf(agent: Agent, s: unknown): Mission {
  const mission = typeof s === "string" ? state.missions.get(s) : undefined;
  if (!mission || mission.agent !== agent.id)
    throw new AAuthError(404, "mission_not_found", "no such mission");
  if (!mission.terminated && now() >= mission.expires_at)
    mission.terminated = "expired";
  if (mission.terminated)
    throw new AAuthError(
      403,
      "mission_terminated",
      `mission ${mission.terminated}`,
      {},
    );
  return mission;
}

/** The trip's budget, as the agent states it in the description: "up to $6,000". */
function budgetOf(description: string): number | null {
  const match = /up to \$([\d,]+)/i.exec(description);
  return match ? Number(match[1].replace(/,/g, "")) * 100 : null;
}

/**
 * `POST /ps/mission`: the agent proposes a trip. Acme's managers approve every
 * trip once, with its budget, before anything is booked.
 */
export async function proposeMission(request: Request): Promise<Response> {
  const body = await request.text();
  const agent = await verifyAgent(request, body, ENDPOINTS.mission);
  const params = readBody(body);
  const person = personFor(agent, params.login_hint);
  const description = String(params.description ?? "");
  const budget = budgetOf(description);
  if (!description || budget === null)
    throw new AAuthError(
      400,
      "invalid_request",
      'describe the trip, with its budget: "up to $N"',
    );
  const resources = (Array.isArray(params.resources) ? params.resources : [])
    .map(String)
    .filter((r) => RESOURCES.includes(r));
  return ask({
    agent,
    person,
    approver: managerOf(person),
    item: description,
    reasons: [`A trip for ${person.name}, up to ${dollars(budget)}`],
    onApprove: async () => {
      const approved_at = new Date().toISOString();
      const expires_at = now() + MISSION_TTL_SECONDS;
      const bytes = JSON.stringify({
        agent: agent.id,
        approved_at,
        expires_at: new Date(expires_at * 1000).toISOString(),
        description,
        approved_resources: resources,
        budget_cents: budget,
      });
      const mission: Mission = {
        s256: s256(bytes),
        bytes,
        agent: agent.id,
        person,
        resources,
        budget_cents: budget,
        spent_cents: 0,
        expires_at,
        log: [],
      };
      state.missions.set(mission.s256, mission);
      const person_tokens = Object.fromEntries(
        await Promise.all(
          resources.map(async (r) => [
            r,
            (await personToken(agent, person, r, mission)).person_token,
          ]),
        ),
      );
      record(
        "acme.mission_approved",
        `mission ${mission.s256.slice(0, 8)}: ${dollars(budget)}`,
        { s256: mission.s256 },
      );
      return {
        s256: mission.s256,
        mission: Buffer.from(bytes).toString("base64url"),
        person_tokens,
      };
    },
  });
}

/** `POST /ps/mission/{s256}`: record a change, or propose the trip is done. */
export async function missionAction(
  request: Request,
  s: string,
): Promise<Response> {
  const body = await request.text();
  const agent = await verifyAgent(request, body, `${ENDPOINTS.mission}/${s}`);
  const params = readBody(body);
  const mission = missionOf(agent, s);
  if (params.action === "update") {
    const entry = String(params.description ?? "");
    mission.log.push({ at: new Date().toISOString(), entry });
    return Response.json({ s256: s256(entry) });
  }
  if (params.action === "completion") {
    return ask({
      agent,
      person: mission.person,
      approver: mission.person,
      item: String(params.summary ?? ""),
      reasons: ["The agent says the trip is booked"],
      onApprove: async () => {
        mission.terminated = "completed";
        record(
          "acme.mission_completed",
          `mission ${mission.s256.slice(0, 8)} completed`,
          { s256: mission.s256 },
        );
        return {};
      },
    });
  }
  throw new AAuthError(
    400,
    "invalid_request",
    "action is update or completion",
  );
}
// #endregion

// #region person-token
async function personToken(
  agent: Agent,
  person: Person,
  resource: string,
  mission?: Mission,
) {
  const { token, expires_in } = await issue(
    "aa-person+jwt",
    {
      aud: resource,
      sub: directed(person, resource),
      cnf: { jwk: agent.jwk },
      ...(mission ? { mission_s256: mission.s256 } : {}),
    },
    Math.min(agent.exp, mission?.expires_at ?? Infinity),
  );
  return { person_token: token, expires_in };
}

/** `POST /ps/person-token`: who the agent acts for, at one resource, under its mission. */
export async function requestPersonToken(request: Request): Promise<Response> {
  const body = await request.text();
  const agent = await verifyAgent(request, body, ENDPOINTS.personToken);
  const params = readBody(body);
  const resource = String(params.resource ?? "");
  if (!RESOURCES.includes(resource))
    throw new AAuthError(400, "invalid_request", "not a resource Acme uses");
  const person = personFor(agent, params.login_hint);
  const mission =
    params.mission_s256 === undefined
      ? undefined
      : missionOf(agent, params.mission_s256);
  return Response.json(await personToken(agent, person, resource, mission));
}
// #endregion

// #region auth-token
/**
 * `POST /ps/token`: the resource token for one booking, and the person token
 * the agent showed the resource. Acme reads the booking from the resource's
 * proposal and checks it against the mission's budget.
 */
export async function authToken(request: Request): Promise<Response> {
  const body = await request.text();
  const agent = await verifyAgent(request, body, ENDPOINTS.token);
  const params = readBody(body);
  const rt = await verifyResourceToken(agent, params);
  const mission = rt.mission_s256
    ? missionOf(agent, rt.mission_s256)
    : undefined;
  if (!mission)
    throw new AAuthError(
      403,
      "access_denied",
      "Acme books travel only under an approved trip",
    );
  if (!mission.resources.includes(String(rt.iss)))
    throw new AAuthError(
      403,
      "access_denied",
      "this trip does not cover that resource",
    );
  const proposal = await readProposal(rt);
  const total = Number(
    decodeJwt(String(proposal.parameters?.quote)).total_cents,
  );
  const grant = async () => {
    mission.spent_cents += total;
    const { token, expires_in } = await issue(
      "aa-auth+jwt",
      {
        aud: rt.iss,
        ps: PS,
        sub: rt.sub,
        cnf: { jwk: agent.jwk },
        scope: rt.scope,
        mission_s256: mission.s256,
        r3_uri: rt.r3_uri,
        r3_s256: rt.r3_s256,
      },
      Math.min(agent.exp, mission.expires_at),
    );
    record(
      "acme.auth_token_issued",
      `${proposal.display?.summary}; ${dollars(mission.budget_cents - mission.spent_cents)} left`,
      {
        s256: mission.s256,
      },
    );
    return { auth_token: token, expires_in };
  };
  const left = mission.budget_cents - mission.spent_cents;
  if (total <= left) return Response.json(await grant());
  return ask({
    agent,
    person: mission.person,
    approver: managerOf(mission.person),
    item: String(proposal.display?.summary ?? "a booking"),
    reasons: [
      `${dollars(total)} is over the ${dollars(left)} left of this trip's budget`,
    ],
    onApprove: grant,
  });
}

/** The resource token names this Person Server and the agent's key, and binds the presented token. */
async function verifyResourceToken(
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
  const rt = await verifyIssued(resource_token, {
    typ: "aa-resource+jwt",
    dwk: "aauth-resource.json",
    issuers: RESOURCES,
  }).catch((err: Error) => {
    throw invalid(err.message);
  });
  if (rt.aud !== PS || rt.ps !== PS)
    throw invalid("not for this Person Server");
  if (rt.agent_jkt !== agent.jkt) throw invalid("agent_jkt is not the signer");
  const signer = await personServerSigner();
  const presented = await jwtVerify(
    presented_token,
    createLocalJWKSet(signer.jwks),
    { issuer: PS },
  )
    .then((r) => r.payload)
    .catch(() => {
      throw new AAuthError(
        400,
        "invalid_presented_token",
        "not a token this Person Server issued",
      );
    });
  if (
    presented.jti !== rt.presented_jti ||
    presented.sub !== rt.sub ||
    presented.mission_s256 !== rt.mission_s256
  )
    throw invalid("does not match the presented token");
  return rt;
}

/** The booking, from the proposal the resource published for this Person Server alone. */
async function readProposal(rt: JWTPayload): Promise<R3Document> {
  if (typeof rt.r3_uri !== "string" || typeof rt.r3_s256 !== "string")
    throw new AAuthError(
      400,
      "invalid_resource_token",
      "no proposal to approve",
    );
  const signer = await personServerSigner();
  const response = await signedFetch(rt.r3_uri, {
    method: "GET",
    signingKey: signer.privateJwk as JsonWebKey,
    signatureKey: { type: "jwks_uri", id: PS, kid: signer.kid, dwk: DWK },
  });
  const bytes = await response.text();
  if (!response.ok || !(await verifyR3Hash(bytes, rt.r3_s256)))
    throw new AAuthError(
      400,
      "invalid_resource_token",
      "the proposal does not match its hash",
    );
  return JSON.parse(bytes);
}
// #endregion

// #region ask
function managerOf(person: Person): Person {
  const manager = people.find((p) => p.external_user_id === person.manager);
  if (!manager)
    throw new AAuthError(
      403,
      "user_unreachable",
      `${person.name} has no manager`,
    );
  return manager;
}

const hash = (code: string) => createHash("sha256").update(code).digest();

/** A person decides, by email with a six-digit code; the agent polls a pending URL meanwhile. */
async function ask(
  request: Omit<
    Pending,
    "id" | "jkt" | "status" | "codeHash" | "expiresAt" | "attempts"
  > & { agent: Agent },
): Promise<Response> {
  const { agent, ...rest } = request;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const pending: Pending = {
    ...rest,
    id: randomUUID(),
    jkt: agent.jkt,
    status: "pending",
    codeHash: hash(code).toString("hex"),
    expiresAt: Date.now() + CODE_TTL_MS,
    attempts: 0,
  };
  state.pending.set(pending.id, pending);
  await sendApprovalEmail({
    to: pending.approver.email,
    approverName: pending.approver.name,
    travellerName: pending.person.name,
    item: pending.item,
    reasons: pending.reasons,
    link: `${PS}/approve/${pending.id}`,
    code,
  });
  record("acme.approval_requested", `asked ${pending.approver.name} by email`, {
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
        "AAuth-Requirement": "requirement=approval",
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
  if (
    !/^\d{6}$/.test(code) ||
    !timingSafeEqual(hash(code), Buffer.from(pending.codeHash, "hex"))
  )
    throw new AAuthError(401, "invalid_code", "that code isn't right");
  if (verdict === "decline") {
    pending.status = "denied";
  } else {
    pending.result = await pending.onApprove();
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
  const [user = "", domain = ""] = pending.approver.email.split("@");
  return {
    status: pending.status,
    company: "Acme",
    traveller: pending.person.name,
    approver: pending.approver.name,
    sentTo: `${user.slice(0, 1)}•••@${domain}`,
    item: pending.item,
    reasons: pending.reasons,
  };
}
