/**
 * Four-party AAuth (draft -11 #access-server-federation), in process: a
 * resource that names its own Access Server, the person's Person Server
 * federating with it, and an agent signing with @hellocoop/httpsig, every
 * party behind one fake fetch.
 *
 * Mock exception 1 of AGENTS.md §6: no LLM call; every party is real code.
 */
import { generateKeyPairSync, randomUUID } from "node:crypto";

import { clearMetadataCache, parseRequirementHeader } from "@aauth/resource";
import { fetch as signedFetch } from "@hellocoop/httpsig";
import {
  type AccessRequest,
  type AccessServer,
  type Verdict,
  createAccessServer,
} from "@introspection-sdk/aauth-access-server";
import {
  type AAuthResource,
  createAAuthResource,
} from "@introspection-sdk/aauth-resource";
import {
  type Approval,
  type PersonServer,
  createPersonServer,
} from "@introspection-sdk/aauth-person-server";
import {
  type JWK,
  type JWTPayload,
  SignJWT,
  calculateJwkThumbprint,
  decodeJwt,
  exportJWK,
  generateKeyPair,
  importPKCS8,
} from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PS = "https://ps.acme.example";
const OTHER_PS = "https://ps.other.example";
const AS = "https://as.flightsector.example";
const RESOURCE = "https://booking.flightsector.example";
const PROVIDER = "https://agents.example";
const USD = { unit: "USD", decimals: 2 };
/** A body's signature that leaves out `content-type`. */
const WITHOUT_CONTENT_TYPE = [
  "@method",
  "@authority",
  "@path",
  "signature-key",
];

// Fixed across tests: @hellocoop/httpsig caches a jwks_uri signer's keys by URL.
const pem = () =>
  generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
const PS_KEY = pem();
const AS_KEY = pem();
const RESOURCE_KEY = pem();
const OTHER_PS_KEY = pem();

interface Party {
  jwk: JWK;
  publicJwk: JWK;
  sign(claims: JWTPayload, typ: string): Promise<string>;
}

async function party(kid: string, key?: string): Promise<Party> {
  const privateKey = key
    ? await importPKCS8(key, "Ed25519", { extractable: true })
    : (await generateKeyPair("Ed25519", { extractable: true })).privateKey;
  const jwk = { ...(await exportJWK(privateKey)), kid, alg: "Ed25519" };
  const publicJwk = { ...jwk };
  delete publicJwk.d;
  return {
    jwk,
    publicJwk,
    sign: (claims, typ) => {
      const iat = Math.floor(Date.now() / 1000);
      return new SignJWT({ iat, exp: iat + 600, jti: randomUUID(), ...claims })
        .setProtectedHeader({ alg: "Ed25519", typ, kid })
        .sign(privateKey);
    },
  };
}

let provider: Party;
let otherPs: Party;
let ps: PersonServer;
let as: AccessServer;
let resource: AAuthResource;
let asked: Approval[];
let policy: (request: AccessRequest) => Verdict;
let decided: AccessRequest[];
let calls: string[];
/** Answers the AS's token and pending routes in place of the real one, when a test sets it. */
type Scripted = (
  request: Request,
) => Response | undefined | Promise<Response | undefined>;
let asAnswer: Scripted | undefined;
/** The AS's metadata in place of its own, when a test sets it. */
let asMetadata: Record<string, unknown> | undefined;

/** The booking resource's one paid call. */
async function reserve(request: Request): Promise<Response> {
  const body = await request.text();
  const { amount } = JSON.parse(body) as { amount: number };
  const authz = await resource.authorize(request, body, {
    scope: "booking.reserve",
    operation: { action: "reserve" },
    parameters: { offer: `QT-${amount}` },
    summary: `QT Sydney for $${amount / 100}`,
    budget: { amount, ...USD },
  });
  return authz.ok
    ? Response.json({ booked: true, sub: authz.sub, ps: authz.ps })
    : authz.response;
}

/** Every party, by origin. */
async function world(
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  const request = input instanceof Request ? input : new Request(input, init);
  const { origin, pathname } = new URL(request.url);
  calls.push(`${request.method} ${origin}${pathname}`);
  const documents: Record<string, unknown> = {
    [`${PROVIDER}/.well-known/aauth-agent.json`]: {
      issuer: PROVIDER,
      jwks_uri: `${PROVIDER}/jwks`,
    },
    [`${PROVIDER}/jwks`]: { keys: [provider.publicJwk] },
    [`${OTHER_PS}/.well-known/aauth-person.json`]: {
      issuer: OTHER_PS,
      jwks_uri: `${OTHER_PS}/jwks`,
    },
    [`${OTHER_PS}/jwks`]: { keys: [otherPs.publicJwk] },
  };
  const document = documents[`${origin}${pathname}`];
  if (document) return Response.json(document);
  if (origin === PS) return ps.handle(request);
  if (
    origin === AS &&
    pathname === "/.well-known/aauth-access.json" &&
    asMetadata
  )
    return Response.json(asMetadata);
  if (origin === AS && !pathname.startsWith("/.well-known/")) {
    const scripted = await asAnswer?.(request);
    if (scripted) return scripted;
  }
  if (origin === AS) return as.handle(request);
  if (origin === RESOURCE && pathname === "/reserve") return reserve(request);
  if (origin === RESOURCE)
    return (
      (await resource.handle(request)) ?? new Response(null, { status: 404 })
    );
  return new Response("not found", { status: 404 });
}

class AgentClient {
  token = "";
  session!: Party;

  static async create() {
    const agent = new AgentClient();
    agent.session = await party("session");
    agent.token = await provider.sign(
      {
        iss: PROVIDER,
        dwk: "aauth-agent.json",
        sub: "aauth:travel@agents.example",
        ps: PS,
        cnf: { jwk: agent.session.publicJwk },
      },
      "aa-agent+jwt",
    );
    return agent;
  }

  /** A request signed with this agent's key, presenting `token` (its agent token by default). */
  async send(
    method: string,
    url: string,
    body?: Record<string, unknown>,
    token = this.token,
    components?: string[],
  ) {
    const text = body ? JSON.stringify(body) : undefined;
    const { headers } = await signedFetch(url, {
      method,
      ...(components ? { components } : {}),
      ...(text
        ? { body: text, headers: { "Content-Type": "application/json" } }
        : {}),
      signingKey: this.session.jwk as JsonWebKey,
      signatureKey: { type: "jwt", jwt: token },
      dryRun: true,
    });
    return world(
      new Request(url, { method, headers, ...(text ? { body: text } : {}) }),
    );
  }
}

/** A signed GET of the AS's pending `url`, as the Person Server. */
async function pollAsPersonServer(url: string) {
  const key = await party(ps.jwks().keys[0]!.kid!, PS_KEY);
  const { headers } = await signedFetch(url, {
    method: "GET",
    signingKey: key.jwk as JsonWebKey,
    signatureKey: {
      type: "jwks_uri",
      id: PS,
      kid: String(key.jwk.kid),
      dwk: "aauth-person.json",
    },
    dryRun: true,
  });
  return as.handle(new Request(url, { headers }));
}

/** A request to the AS signed as a Person Server with `key`. */
async function asPersonServer(
  id: string,
  key: Party,
  body: unknown,
  components?: string[],
) {
  const text = JSON.stringify(body);
  const { headers } = await signedFetch(`${AS}/token`, {
    method: "POST",
    ...(components ? { components } : {}),
    body: text,
    headers: { "Content-Type": "application/json" },
    signingKey: key.jwk as JsonWebKey,
    signatureKey: {
      type: "jwks_uri",
      id,
      kid: String(key.jwk.kid),
      dwk: "aauth-person.json",
    },
    dryRun: true,
  });
  return as.handle(
    new Request(`${AS}/token`, { method: "POST", headers, body: text }),
  );
}

beforeEach(async () => {
  clearMetadataCache();
  vi.stubGlobal("fetch", world);
  provider = await party("provider");
  otherPs = await party("other-ps", OTHER_PS_KEY);
  asked = [];
  decided = [];
  calls = [];
  asAnswer = undefined;
  asMetadata = undefined;
  policy = (request) =>
    request.tenant === "acme"
      ? { decision: "allow" }
      : { decision: "deny", detail: "no Flight Sector account" };
  ps = await createPersonServer({
    issuer: PS,
    basePath: "/ps",
    trustedAgentProviders: [PROVIDER],
    signingKey: PS_KEY,
    defaultTenant: "acme",
    directory: {
      person: (hint) =>
        hint === "sam@acme.example"
          ? { id: "sam", name: "Sam", tenant: "acme" }
          : undefined,
      approver: () => ({ id: "dana", name: "Dana", tenant: "acme" }),
    },
    onApproval: (approval) => {
      asked.push(approval);
    },
    fetch: world,
  });
  as = await createAccessServer({
    issuer: AS,
    resources: [RESOURCE],
    personServers: [PS, OTHER_PS],
    agentProviders: [PROVIDER],
    signingKey: AS_KEY,
    policy: (request) => {
      decided.push(request);
      return policy(request);
    },
    fetch: world,
  });
  resource = await createAAuthResource({
    issuer: RESOURCE,
    name: "Booking",
    scopes: { "booking.reserve": "Reserve" },
    personServers: [PS],
    agentProviders: [PROVIDER],
    accessServer: AS,
    signingKey: RESOURCE_KEY,
    kid: "booking-1",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A mission over `resources`, approved with a budget of `amount`; its person token for the booking resource. */
async function approvedTrip(
  agent: AgentClient,
  amount = 300_000,
  resources = [RESOURCE],
) {
  const proposed = await agent.send("POST", `${PS}/ps/mission`, {
    description: "Sydney",
    resources,
    login_hint: "sam@acme.example",
  });
  await ps.decide("acme", asked.at(-1)!.id, {
    status: "approved",
    budget: { amount, ...USD },
  });
  const trip = (await (
    await agent.send("GET", proposed.headers.get("location")!)
  ).json()) as { s256: string; person_tokens: Record<string, string> };
  const personToken =
    trip.person_tokens[RESOURCE] ??
    (
      (await (
        await agent.send("POST", `${PS}/ps/person-token`, {
          resource: RESOURCE,
          mission_s256: trip.s256,
        })
      ).json()) as { person_token: string }
    ).person_token;
  return { s256: trip.s256, personToken };
}

/** Call the resource with `token`; its resource token when it challenges for an auth token. */
async function challenge(agent: AgentClient, token: string, amount: number) {
  const response = await agent.send(
    "POST",
    `${RESOURCE}/reserve`,
    { amount },
    token,
  );
  expect(response.status).toBe(401);
  const parsed = parseRequirementHeader(
    response.headers.get("aauth-requirement")!,
  );
  expect(parsed.requirement).toBe("auth-token");
  return parsed.resourceToken!;
}

const problem500 = () =>
  Response.json(
    { error: "server_error" },
    { status: 500, headers: { "Content-Type": "application/problem+json" } },
  );

const spent = async (s256: string) => (await ps.mission("acme", s256))?.spent;

describe("@introspection-sdk/aauth-access-server federation", () => {
  it("publishes its metadata and keys", async () => {
    const metadata = await (
      await as.handle(new Request(`${AS}/.well-known/aauth-access.json`))
    ).json();
    expect(metadata).toEqual({
      issuer: AS,
      jwks_uri: `${AS}/.well-known/jwks.json`,
      auth_token_endpoint: `${AS}/token`,
    });
    expect(as.jwks().keys).toHaveLength(1);
  });

  it("is redeemed by the Person Server, and its auth token admits the call", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    const resourceToken = await challenge(agent, trip.personToken, 165_000);
    expect(decodeJwt(resourceToken)).toMatchObject({ aud: AS, ps: PS });

    const issued = await agent.send("POST", `${PS}/ps/token`, {
      resource_token: resourceToken,
      presented_token: trip.personToken,
    });
    expect(issued.status).toBe(200);
    const { auth_token } = (await issued.json()) as { auth_token: string };
    const claims = decodeJwt(auth_token);
    const rt = decodeJwt(resourceToken);
    expect(claims).toMatchObject({
      iss: AS,
      dwk: "aauth-access.json",
      aud: RESOURCE,
      ps: PS,
      sub: rt.sub,
      mission_s256: trip.s256,
      scope: "booking.reserve",
      cnf: { jwk: { x: agent.session.publicJwk.x } },
    });
    expect(Number(claims.exp) - Number(claims.iat)).toBeLessThanOrEqual(3600);
    expect(claims.budget).toEqual({ amount: 165_000, ...USD });
    expect(decided[0]).toMatchObject({
      resource: RESOURCE,
      ps: PS,
      tenant: "acme",
      mission_s256: trip.s256,
      budget: { amount: 165_000, ...USD },
      summary: "QT Sydney for $1650",
      agent: {
        provider: PROVIDER,
        jkt: await calculateJwkThumbprint(agent.session.publicJwk),
      },
    });
    expect(await spent(trip.s256)).toBe(165_000);

    const booked = await agent.send(
      "POST",
      `${RESOURCE}/reserve`,
      { amount: 165_000 },
      auth_token,
    );
    expect(booked.status).toBe(200);
    expect(await booked.json()).toMatchObject({ booked: true, ps: PS });
  });

  it("relays a refusal, and spends nothing until the Access Server issues", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    policy = () => ({ decision: "deny", detail: "no Flight Sector account" });
    const resourceToken = await challenge(agent, trip.personToken, 100_000);
    const refused = await agent.send("POST", `${PS}/ps/token`, {
      resource_token: resourceToken,
      presented_token: trip.personToken,
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({
      error: "denied",
      detail: expect.stringContaining("no Flight Sector account"),
    });
    expect(await spent(trip.s256)).toBe(0);
  });

  it("refuses a request not signed by the Person Server the resource token names", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    const tokens = {
      resource_token: await challenge(agent, trip.personToken, 100_000),
      agent_token: agent.token,
      presented_token: trip.personToken,
    };
    const other = await asPersonServer(OTHER_PS, otherPs, tokens);
    expect(other.status).toBe(400);
    expect(await other.json()).toMatchObject({
      error: "invalid_resource_token",
    });
    const stranger = await asPersonServer(
      "https://ps.stranger.example",
      otherPs,
      tokens,
    );
    expect(stranger.status).toBe(401);
    expect(decided).toHaveLength(0);
  });

  it("refuses a resource token for another audience", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    const rt = decodeJwt(await challenge(agent, trip.personToken, 100_000));
    const signer = await party("booking-1", RESOURCE_KEY);
    const elsewhere = await signer.sign(
      { ...rt, aud: "https://as.elsewhere.example" },
      "aa-resource+jwt",
    );
    const response = await asPersonServer(
      PS,
      await party(ps.jwks().keys[0]!.kid!, PS_KEY),
      {
        resource_token: elsewhere,
        agent_token: agent.token,
        presented_token: trip.personToken,
      },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_resource_token",
      detail: expect.stringContaining("aud"),
    });
  });

  it("does not federate for a resource the mission does not cover", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent, 300_000, ["https://hotels.example"]);
    const resourceToken = await challenge(agent, trip.personToken, 100_000);
    calls = [];
    const refused = await agent.send("POST", `${PS}/ps/token`, {
      resource_token: resourceToken,
      presented_token: trip.personToken,
    });
    expect(refused.status).toBe(403);
    expect(calls.filter((c) => c.includes(AS))).toEqual([]);
  });

  it("waits on the Access Server's approval, then hands its auth token out once", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    policy = () => ({ decision: "approval" });
    const resourceToken = await challenge(agent, trip.personToken, 120_000);
    const waiting = await agent.send("POST", `${PS}/ps/token`, {
      resource_token: resourceToken,
      presented_token: trip.personToken,
    });
    expect(waiting.status).toBe(202);
    expect(waiting.headers.get("aauth-requirement")).toBe(
      "requirement=approval",
    );
    const location = waiting.headers.get("location")!;
    expect(location.startsWith(`${PS}/ps/pending/`)).toBe(true);
    expect((await agent.send("GET", location)).status).toBe(202);
    expect(await spent(trip.s256)).toBe(0);

    const [pending] = as.pendings();
    expect(pending).toMatchObject({
      status: "pending",
      requirement: "approval",
    });
    as.decide(pending!.id, { status: "approved", decided_by: "ops" });
    const collected = await agent.send("GET", location);
    expect(collected.status).toBe(200);
    const { auth_token } = (await collected.json()) as { auth_token: string };
    expect(decodeJwt(auth_token)).toMatchObject({ iss: AS, aud: RESOURCE });
    expect(await spent(trip.s256)).toBe(120_000);
    const again = await agent.send("GET", location);
    expect(again.status).toBe(410);
    expect(await again.json()).toMatchObject({ error: "invalid_code" });
    expect(as.pendings()[0]).toMatchObject({ status: "approved" });
    const stored = (await ps.approvals("acme")).find(
      (a) => a.kind === "auth_token",
    );
    expect(stored).toMatchObject({
      kind: "auth_token",
      status: "approved",
      answered_at: expect.any(Number),
    });
  });

  it("relays the Access Server's interaction to the agent, and its denial", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    policy = () => ({
      decision: "interaction",
      url: `${AS}/bind`,
      code: "ABCD-1234",
    });
    const waiting = await agent.send("POST", `${PS}/ps/token`, {
      resource_token: await challenge(agent, trip.personToken, 120_000),
      presented_token: trip.personToken,
    });
    expect(waiting.status).toBe(202);
    expect(
      parseRequirementHeader(waiting.headers.get("aauth-requirement")!),
    ).toMatchObject({
      requirement: "interaction",
      url: `${AS}/bind`,
      code: "ABCD-1234",
    });
    as.decide(as.pendings()[0]!.id, { status: "denied" });
    const location = waiting.headers.get("location")!;
    const denied = await agent.send("GET", location);
    expect(denied.status).toBe(403);
    expect((await agent.send("GET", location)).status).toBe(410);
    expect(
      (await ps.approvals("acme")).find((a) => a.kind === "auth_token"),
    ).toMatchObject({ status: "denied", decided_by: AS });
    expect(await spent(trip.s256)).toBe(0);
  });

  it("asks the approver first when the call is over what is left, then federates", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent, 100_000);
    const resourceToken = await challenge(agent, trip.personToken, 150_000);
    calls = [];
    const waiting = await agent.send("POST", `${PS}/ps/token`, {
      resource_token: resourceToken,
      presented_token: trip.personToken,
    });
    expect(waiting.status).toBe(202);
    expect(calls.filter((c) => c.includes(AS))).toEqual([]);
    expect(asked.at(-1)).toMatchObject({
      kind: "auth_token",
      summary: "QT Sydney for $1500",
      federation: { access_server: AS, within_budget: false },
    });
    await ps.decide("acme", asked.at(-1)!.id, { status: "approved" });
    const collected = await agent.send("GET", waiting.headers.get("location")!);
    expect(collected.status).toBe(200);
    expect(await spent(trip.s256)).toBe(150_000);
  });

  it("sends the Access Server the budget, which may grant less, and only that is spent", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    policy = () => ({ decision: "allow", budget: { amount: 90_000, ...USD } });
    const sent: unknown[] = [];
    asAnswer = async (request) => {
      if (request.method === "POST")
        sent.push(
          (JSON.parse(await request.clone().text()) as { budget?: unknown })
            .budget,
        );
      return undefined;
    };
    const resourceToken = await challenge(agent, trip.personToken, 120_000);
    const issued = await agent.send("POST", `${PS}/ps/token`, {
      resource_token: resourceToken,
      presented_token: trip.personToken,
    });
    expect(issued.status).toBe(200);
    expect(sent).toEqual([{ amount: 120_000, ...USD }]);
    const { auth_token } = (await issued.json()) as { auth_token: string };
    expect(decodeJwt(auth_token).budget).toEqual({ amount: 90_000, ...USD });
    expect(await spent(trip.s256)).toBe(90_000);
  });

  it("refuses an auth token whose budget exceeds the one sent, or that lives over an hour", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    const kid = as.jwks().keys[0]!.kid as string;
    const forged = await party(kid, AS_KEY);
    for (const [claims, wrong] of [
      [{ budget: { amount: 130_000, ...USD } }, "budget"],
      [
        {
          budget: { amount: 100_000, ...USD },
          exp: Math.floor(Date.now() / 1000) + 7200,
        },
        "lives longer",
      ],
    ] as const) {
      const resourceToken = await challenge(agent, trip.personToken, 100_000);
      const rt = decodeJwt(resourceToken);
      asAnswer = async () =>
        Response.json({
          auth_token: await forged.sign(
            {
              iss: AS,
              dwk: "aauth-access.json",
              aud: RESOURCE,
              ps: PS,
              sub: rt.sub,
              mission_s256: trip.s256,
              scope: "booking.reserve",
              cnf: { jwk: agent.session.publicJwk },
              ...claims,
            },
            "aa-auth+jwt",
          ),
        });
      const answered = await agent.send("POST", `${PS}/ps/token`, {
        resource_token: resourceToken,
        presented_token: trip.personToken,
      });
      expect(answered.status).toBe(502);
      expect(await answered.json()).toMatchObject({
        error: "as_unreachable",
        detail: expect.stringContaining(wrong),
      });
    }
    expect(await spent(trip.s256)).toBe(0);
  });

  it("polls through a requirement it does not know as approval, and refuses one it does not serve", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    const pendingAt = (requirement: string) => () =>
      new Response(null, {
        status: 202,
        headers: {
          Location: `${AS}/pending/scripted`,
          "AAuth-Requirement": `requirement=${requirement}`,
        },
      });
    asAnswer = pendingAt("something-new");
    const unknown = await agent.send("POST", `${PS}/ps/token`, {
      resource_token: await challenge(agent, trip.personToken, 50_000),
      presented_token: trip.personToken,
    });
    expect(unknown.status).toBe(202);
    expect(unknown.headers.get("aauth-requirement")).toBe(
      "requirement=approval",
    );

    asAnswer = pendingAt("claims");
    const claims = await agent.send("POST", `${PS}/ps/token`, {
      resource_token: await challenge(agent, trip.personToken, 50_000),
      presented_token: trip.personToken,
    });
    expect(claims.status).toBe(403);
    expect(await claims.json()).toMatchObject({ error: "denied" });
  });

  it("keeps waiting while the Access Server is busy", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    policy = () => ({ decision: "approval" });
    const waiting = await agent.send("POST", `${PS}/ps/token`, {
      resource_token: await challenge(agent, trip.personToken, 60_000),
      presented_token: trip.personToken,
    });
    const location = waiting.headers.get("location")!;
    asAnswer = (request) =>
      request.method === "GET"
        ? new Response(null, { status: 503, headers: { "Retry-After": "3" } })
        : undefined;
    expect((await agent.send("GET", location)).status).toBe(202);
    asAnswer = undefined;
    as.decide(as.pendings()[0]!.id, { status: "approved" });
    expect((await agent.send("GET", location)).status).toBe(200);
  });

  it("refuses to pass on a subagent_token or upstream_token", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    const refused = await agent.send("POST", `${PS}/ps/token`, {
      resource_token: await challenge(agent, trip.personToken, 10_000),
      presented_token: trip.personToken,
      upstream_token: "eyJ.upstream",
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_request" });
    expect(calls.some((c) => c.startsWith(`POST ${AS}`))).toBe(false);
  });

  it("refuses a negative grant from the Access Server, and spends nothing", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    const kid = as.jwks().keys[0]!.kid as string;
    const forged = await party(kid, AS_KEY);
    const resourceToken = await challenge(agent, trip.personToken, 50_000);
    const rt = decodeJwt(resourceToken);
    asAnswer = async () =>
      Response.json({
        auth_token: await forged.sign(
          {
            iss: AS,
            dwk: "aauth-access.json",
            aud: RESOURCE,
            ps: PS,
            sub: rt.sub,
            mission_s256: trip.s256,
            scope: "booking.reserve",
            budget: { amount: -50_000, ...USD },
            cnf: { jwk: agent.session.publicJwk },
          },
          "aa-auth+jwt",
        ),
      });
    const answered = await agent.send("POST", `${PS}/ps/token`, {
      resource_token: resourceToken,
      presented_token: trip.personToken,
    });
    expect(answered.status).toBe(502);
    expect(await answered.json()).toMatchObject({
      error: "as_unreachable",
      detail: expect.stringContaining("budget"),
    });
    expect(await spent(trip.s256)).toBe(0);
  });

  it("refuses a negative budget from its own policy", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    policy = () => ({ decision: "allow", budget: { amount: -1, ...USD } });
    const answered = await agent.send("POST", `${PS}/ps/token`, {
      resource_token: await challenge(agent, trip.personToken, 50_000),
      presented_token: trip.personToken,
    });
    expect(answered.status).toBe(502);
    expect(await spent(trip.s256)).toBe(0);
  });

  it("the resource refuses an auth token whose budget does not cover the call", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    policy = () => ({ decision: "allow", budget: { amount: 1, ...USD } });
    const resourceToken = await challenge(agent, trip.personToken, 100_000);
    const issued = await agent.send("POST", `${PS}/ps/token`, {
      resource_token: resourceToken,
      presented_token: trip.personToken,
    });
    expect(issued.status).toBe(200);
    const { auth_token } = (await issued.json()) as { auth_token: string };
    expect(decodeJwt(auth_token).budget).toEqual({ amount: 1, ...USD });
    const booked = await agent.send(
      "POST",
      `${RESOURCE}/reserve`,
      { amount: 100_000 },
      auth_token,
    );
    expect(booked.status).toBe(401);
    expect(booked.headers.get("aauth-requirement")).toContain("auth-token");
  });

  it("the resource refuses an auth token without the call's scope", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    policy = () => ({ decision: "allow", scope: "" });
    const resourceToken = await challenge(agent, trip.personToken, 20_000);
    const issued = await agent.send("POST", `${PS}/ps/token`, {
      resource_token: resourceToken,
      presented_token: trip.personToken,
    });
    expect(issued.status).toBe(200);
    const { auth_token } = (await issued.json()) as { auth_token: string };
    expect(decodeJwt(auth_token).scope).toBeUndefined();
    const booked = await agent.send(
      "POST",
      `${RESOURCE}/reserve`,
      { amount: 20_000 },
      auth_token,
    );
    expect(booked.status).toBe(401);
  });

  it("sends no token to an Access Server whose metadata is not https", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    asMetadata = {
      issuer: AS,
      jwks_uri: `${AS}/.well-known/jwks.json`,
      auth_token_endpoint: "http://as.flightsector.example/token",
    };
    const answered = await agent.send("POST", `${PS}/ps/token`, {
      resource_token: await challenge(agent, trip.personToken, 10_000),
      presented_token: trip.personToken,
    });
    expect(answered.status).toBe(502);
    expect(await answered.json()).toMatchObject({ error: "as_unreachable" });
    expect(calls.some((c) => c.startsWith("POST http://"))).toBe(false);
  });

  it("a resource with an AS refuses a PS-issued auth token", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    const rt = decodeJwt(await challenge(agent, trip.personToken, 100_000));
    // Everything the AS would have issued, but minted by the Person Server itself.
    const psKey = await party(ps.jwks().keys[0]!.kid!, PS_KEY);
    const minted = await psKey.sign(
      {
        iss: PS,
        dwk: "aauth-person.json",
        jti: "minted-by-ps",
        aud: RESOURCE,
        ps: PS,
        sub: rt.sub,
        mission_s256: rt.mission_s256,
        scope: "booking.reserve",
        r3_uri: rt.r3_uri,
        r3_s256: rt.r3_s256,
        cnf: { jwk: agent.session.publicJwk },
      },
      "aa-auth+jwt",
    );
    const response = await agent.send(
      "POST",
      `${RESOURCE}/reserve`,
      { amount: 100_000 },
      minted,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("signature-error")).toContain("invalid_jwt");
  });

  it("refuses an auth token from a Person Server that is not this resource's", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    // Signed by the resource's Access Server key, but claiming another Person Server.
    const asKey = await party(as.jwks().keys[0]!.kid!, AS_KEY);
    const forged = await asKey.sign(
      {
        iss: AS,
        dwk: "aauth-access.json",
        jti: "forged",
        aud: RESOURCE,
        ps: OTHER_PS,
        sub: decodeJwt(trip.personToken).sub,
        scope: "booking.reserve",
        cnf: { jwk: agent.session.publicJwk },
      },
      "aa-auth+jwt",
    );
    const response = await agent.send(
      "POST",
      `${RESOURCE}/reserve`,
      { amount: 1 },
      forged,
    );
    expect(response.status).toBe(401);
  });
  it("refuses a signed body whose signature leaves out content-type", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    const tokens = {
      resource_token: await challenge(agent, trip.personToken, 10_000),
      presented_token: trip.personToken,
    };
    const atPs = await agent.send(
      "POST",
      `${PS}/ps/token`,
      tokens,
      agent.token,
      WITHOUT_CONTENT_TYPE,
    );
    expect(atPs.status).toBe(401);
    expect(atPs.headers.get("signature-error")).toContain("invalid_signature");
    const atAs = await asPersonServer(
      PS,
      await party(ps.jwks().keys[0]!.kid!, PS_KEY),
      { ...tokens, agent_token: agent.token },
      WITHOUT_CONTENT_TYPE,
    );
    expect(atAs.status).toBe(401);
    expect(atAs.headers.get("signature-error")).toContain("invalid_signature");
    const atResource = await agent.send(
      "POST",
      `${RESOURCE}/reserve`,
      { amount: 10_000 },
      trip.personToken,
      WITHOUT_CONTENT_TYPE,
    );
    expect(atResource.status).toBe(401);
    expect(atResource.headers.get("signature-error")).toContain(
      "invalid_signature",
    );
    expect(decided).toHaveLength(0);
  });

  it("refuses a body that is not a JSON object", async () => {
    const response = await asPersonServer(
      PS,
      await party(ps.jwks().keys[0]!.kid!, PS_KEY),
      [],
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_request",
      detail: expect.stringContaining("JSON object"),
    });
  });

  it("takes an Access Server that names itself with a trailing slash", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    asMetadata = {
      issuer: `${AS}/`,
      jwks_uri: `${AS}/.well-known/jwks.json`,
      auth_token_endpoint: `${AS}/token`,
    };
    const issued = await agent.send("POST", `${PS}/ps/token`, {
      resource_token: await challenge(agent, trip.personToken, 10_000),
      presented_token: trip.personToken,
    });
    expect(issued.status).toBe(200);
  });

  it("refuses an auth token that drops what the resource token carries, or has no jti", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    const forged = await party(as.jwks().keys[0]!.kid!, AS_KEY);
    const booking = await party("booking-1", RESOURCE_KEY);
    const cases: [JWTPayload, string][] = [
      [{ account: undefined }, "account"],
      [{ r3_uri: `${RESOURCE}/r3/other` }, "r3_uri"],
      [{ r3_s256: "other" }, "r3_s256"],
      [{ jti: undefined }, "no jti"],
    ];
    for (const [claims, wrong] of cases) {
      const rt = decodeJwt(await challenge(agent, trip.personToken, 30_000));
      const resourceToken = await booking.sign(
        { ...rt, account: "acct-7" },
        "aa-resource+jwt",
      );
      asAnswer = async () =>
        Response.json({
          auth_token: await forged.sign(
            {
              iss: AS,
              dwk: "aauth-access.json",
              aud: RESOURCE,
              ps: PS,
              sub: rt.sub,
              mission_s256: trip.s256,
              scope: "booking.reserve",
              account: "acct-7",
              r3_uri: rt.r3_uri,
              r3_s256: rt.r3_s256,
              budget: { amount: 30_000, ...USD },
              cnf: { jwk: agent.session.publicJwk },
              ...claims,
            },
            "aa-auth+jwt",
          ),
        });
      const answered = await agent.send("POST", `${PS}/ps/token`, {
        resource_token: resourceToken,
        presented_token: trip.personToken,
      });
      expect(answered.status).toBe(502);
      expect(await answered.json()).toMatchObject({
        error: "as_unreachable",
        detail: expect.stringContaining(wrong),
      });
    }
    expect(await spent(trip.s256)).toBe(0);
  });

  it("asks a busy Access Server again on the agent's next poll", async () => {
    for (const status of [429, 503]) {
      const agent = await AgentClient.create();
      const trip = await approvedTrip(agent);
      let busy = true;
      asAnswer = (request) =>
        request.method === "POST" && busy
          ? new Response(null, { status, headers: { "Retry-After": "7" } })
          : undefined;
      const waiting = await agent.send("POST", `${PS}/ps/token`, {
        resource_token: await challenge(agent, trip.personToken, 40_000),
        presented_token: trip.personToken,
      });
      expect(waiting.status).toBe(202);
      expect(waiting.headers.get("retry-after")).toBe("7");
      const [kept] = (await ps.approvals("acme")).filter(
        (a) => a.kind === "auth_token" && a.mission_s256 === trip.s256,
      );
      expect(kept).toMatchObject({ status: "approved" });
      expect(kept!.federation?.location).toBeUndefined();
      expect(await spent(trip.s256)).toBe(0);
      busy = false;
      const issued = await agent.send("GET", waiting.headers.get("location")!);
      expect(issued.status).toBe(200);
      expect(await spent(trip.s256)).toBe(40_000);
    }
  });

  it("asks again, rather than denying, when the Access Server fails", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent, 100_000);
    const waiting = await agent.send("POST", `${PS}/ps/token`, {
      resource_token: await challenge(agent, trip.personToken, 150_000),
      presented_token: trip.personToken,
    });
    expect(waiting.status).toBe(202);
    await ps.decide("acme", asked.at(-1)!.id, { status: "approved" });
    const location = waiting.headers.get("location")!;
    asAnswer = (request) =>
      request.method === "POST" ? problem500() : undefined;
    expect((await agent.send("GET", location)).status).toBe(502);
    expect(await ps.approval("acme", asked.at(-1)!.id)).toMatchObject({
      status: "approved",
    });
    asAnswer = undefined;
    expect((await agent.send("GET", location)).status).toBe(200);
    expect(await spent(trip.s256)).toBe(150_000);
  });

  it("refuses a policy's interaction it cannot send, and keeps no record of it", async () => {
    for (const interaction of [
      { url: "http://as.flightsector.example/bind", code: "ABCD-1234" },
      { url: `${AS}/bind`, code: "ABCD-12\u00e934" },
    ]) {
      const agent = await AgentClient.create();
      const trip = await approvedTrip(agent);
      policy = () => ({ decision: "interaction", ...interaction });
      const answered = await agent.send("POST", `${PS}/ps/token`, {
        resource_token: await challenge(agent, trip.personToken, 20_000),
        presented_token: trip.personToken,
      });
      expect(answered.status).toBe(502);
      expect(as.pendings()).toHaveLength(0);
    }
  });

  it("the resource refuses an auth token without a jti, or that lives over an hour", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    const asKey = await party(as.jwks().keys[0]!.kid!, AS_KEY);
    const now = Math.floor(Date.now() / 1000);
    for (const claims of [{ jti: undefined }, { exp: now + 7200 }]) {
      const token = await asKey.sign(
        {
          iss: AS,
          dwk: "aauth-access.json",
          aud: RESOURCE,
          ps: PS,
          sub: decodeJwt(trip.personToken).sub,
          scope: "booking.reserve",
          cnf: { jwk: agent.session.publicJwk },
          ...claims,
        },
        "aa-auth+jwt",
      );
      const response = await agent.send(
        "POST",
        `${RESOURCE}/reserve`,
        { amount: 1 },
        token,
      );
      expect(response.status).toBe(401);
      expect(response.headers.get("signature-error")).toContain("invalid_jwt");
    }
  });
  it("answers a denied pending request once, and 410 after", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    policy = () => ({ decision: "approval" });
    let location = "";
    asAnswer = async (request) => {
      if (request.method !== "POST") return undefined;
      const answered = await as.handle(request);
      location = answered.headers.get("location") ?? "";
      return answered;
    };
    await agent.send("POST", `${PS}/ps/token`, {
      resource_token: await challenge(agent, trip.personToken, 10_000),
      presented_token: trip.personToken,
    });
    as.decide(as.pendings()[0]!.id, { status: "denied" });
    expect((await pollAsPersonServer(location)).status).toBe(403);
    expect((await pollAsPersonServer(location)).status).toBe(410);
    expect(as.pendings()[0]).toMatchObject({
      status: "denied",
      answered_at: expect.any(Number),
    });
  });

  it("sends no token to an Access Server whose endpoints are on another origin", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    for (const moved of [
      { auth_token_endpoint: "https://collector.example/token" },
      { jwks_uri: "https://collector.example/jwks.json" },
    ]) {
      asMetadata = {
        issuer: AS,
        jwks_uri: `${AS}/.well-known/jwks.json`,
        auth_token_endpoint: `${AS}/token`,
        ...moved,
      };
      calls = [];
      const answered = await agent.send("POST", `${PS}/ps/token`, {
        resource_token: await challenge(agent, trip.personToken, 10_000),
        presented_token: trip.personToken,
      });
      expect(answered.status).toBe(502);
      expect(calls.some((c) => c.includes("collector.example"))).toBe(false);
    }
  });
});
