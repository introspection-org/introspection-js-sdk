/**
 * @introspection-sdk/person-server end to end, in process: an agent signing
 * with @hellocoop/httpsig, an agent provider and a resource behind an
 * injected fetch, and an operator deciding approvals.
 */
import { createHash } from "node:crypto";

import { clearMetadataCache } from "@aauth/resource";
import { fetch as signedFetch } from "@hellocoop/httpsig";
import {
  createPersonServer,
  type Approval,
  type Person,
  type PersonServer,
} from "@introspection-sdk/person-server";
import {
  type JWK,
  type JWTPayload,
  SignJWT,
  createLocalJWKSet,
  decodeJwt,
  exportJWK,
  generateKeyPair,
  jwtVerify,
} from "jose";
import { beforeEach, describe, expect, it } from "vitest";

const PS = "https://ps.acme.example";
const PROVIDER = "https://agents.example";
const RESOURCE = "https://booking.example";
const R3 = `${RESOURCE}/r3/1`;
const USD = { unit: "USD", decimals: 2 };

const people: Person[] = [
  {
    id: "sam",
    name: "Sam",
    email: "sam@acme.example",
    tenant: "acme",
    manager: "dana",
  },
  { id: "dana", name: "Dana", email: "dana@acme.example", tenant: "acme" },
];

interface Party {
  key: CryptoKey;
  jwk: JWK;
  publicJwk: JWK;
  sign(claims: JWTPayload, typ: string): Promise<string>;
}

async function party(kid: string): Promise<Party> {
  const { privateKey, publicKey } = await generateKeyPair("Ed25519", {
    extractable: true,
  });
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg: "Ed25519" };
  const jwk = { ...(await exportJWK(privateKey)), kid, alg: "Ed25519" };
  return {
    key: privateKey,
    jwk,
    publicJwk,
    sign: (claims, typ) => {
      const iat = Math.floor(Date.now() / 1000);
      return new SignJWT({
        iat,
        exp: iat + 600,
        jti: crypto.randomUUID(),
        ...claims,
      })
        .setProtectedHeader({ alg: "Ed25519", typ, kid })
        .sign(privateKey);
    },
  };
}

let provider: Party;
let resource: Party;
let proposal: string;

/** What the Person Server fetches: the provider's and the resource's keys, and the R3 proposal. */
async function world(input: string): Promise<Response> {
  const documents: Record<string, unknown> = {
    [`${PROVIDER}/.well-known/aauth-agent.json`]: {
      issuer: PROVIDER,
      jwks_uri: `${PROVIDER}/jwks`,
    },
    [`${PROVIDER}/jwks`]: { keys: [provider.publicJwk] },
    [`${RESOURCE}/.well-known/aauth-resource.json`]: {
      issuer: RESOURCE,
      jwks_uri: `${RESOURCE}/jwks`,
    },
    [`${RESOURCE}/jwks`]: { keys: [resource.publicJwk] },
  };
  if (input === R3) return new Response(proposal);
  const body = documents[input];
  return body
    ? Response.json(body)
    : new Response("not found", { status: 404 });
}

class AgentClient {
  token = "";
  session!: Party;

  static async create(sub = "aauth:travel@agents.example") {
    const agent = new AgentClient();
    agent.session = await party("session");
    agent.token = await provider.sign(
      {
        iss: PROVIDER,
        dwk: "aauth-agent.json",
        sub,
        ps: PS,
        cnf: { jwk: agent.session.publicJwk },
      },
      "aa-agent+jwt",
    );
    return agent;
  }

  async request(method: string, url: string, body?: Record<string, unknown>) {
    const text = body ? JSON.stringify(body) : undefined;
    const { headers } = await signedFetch(url, {
      method,
      ...(text
        ? { body: text, headers: { "Content-Type": "application/json" } }
        : {}),
      signingKey: this.session.jwk as JsonWebKey,
      signatureKey: { type: "jwt", jwt: this.token },
      dryRun: true,
    });
    return new Request(url, {
      method,
      headers,
      ...(text ? { body: text } : {}),
    });
  }
}

async function resourceToken(
  agent: AgentClient,
  presented: string,
  amount?: number,
) {
  const person = decodeJwt(presented);
  return resource.sign(
    {
      iss: RESOURCE,
      dwk: "aauth-resource.json",
      aud: PS,
      ps: PS,
      sub: person.sub,
      presented_jti: person.jti,
      agent_jkt: await thumbprint(agent.session.publicJwk),
      mission_s256: person.mission_s256,
      tenant: person.tenant,
      scope: "booking.reserve",
      r3_uri: R3,
      r3_s256: createHash("sha256").update(proposal).digest("base64url"),
      ...(amount !== undefined ? { budget: { amount, ...USD } } : {}),
    },
    "aa-resource+jwt",
  );
}

async function thumbprint(jwk: JWK) {
  const { calculateJwkThumbprint } = await import("jose");
  return calculateJwkThumbprint(jwk);
}

let ps: PersonServer;
let asked: Approval[];

beforeEach(async () => {
  clearMetadataCache();
  provider = await party("provider");
  resource = await party("resource");
  proposal = JSON.stringify({
    display: { summary: "QT Sydney, 4 nights, $1,680" },
  });
  asked = [];
  ps = await createPersonServer({
    issuer: PS,
    basePath: "/ps",
    trustedAgentProviders: [PROVIDER],
    directory: {
      person: (hint) => people.find((p) => p.email === hint),
      approver: (_, person) => people.find((p) => p.id === person.manager),
    },
    onApproval: (approval) => {
      asked.push(approval);
    },
    adminToken: "admin",
    fetch: world,
  });
});

const call = async (
  agent: AgentClient,
  method: string,
  path: string,
  body?: Record<string, unknown>,
) => ps.handle(await agent.request(method, `${PS}${path}`, body));

async function approvedTrip(agent: AgentClient, amount = 300_000) {
  const proposed = await call(agent, "POST", "/ps/mission", {
    description: "Sydney, up to $3,000",
    resources: [RESOURCE],
    login_hint: "sam@acme.example",
  });
  expect(proposed.status).toBe(202);
  const pendingPath = new URL(proposed.headers.get("location")!).pathname;
  expect((await call(agent, "GET", pendingPath)).status).toBe(202);
  await ps.decide(asked.at(-1)!.id, {
    status: "approved",
    budget: { amount, ...USD },
    decided_by: "dana",
  });
  const approved = await call(agent, "GET", pendingPath);
  expect(approved.status).toBe(200);
  return (await approved.json()) as {
    s256: string;
    mission: string;
    person_tokens: Record<string, string>;
  };
}

describe("@introspection-sdk/person-server", () => {
  it("publishes its metadata and keys", async () => {
    const metadata = await (
      await ps.handle(new Request(`${PS}/.well-known/aauth-person.json`))
    ).json();
    expect(metadata).toMatchObject({
      issuer: PS,
      mission_endpoint: `${PS}/ps/mission`,
      person_token_endpoint: `${PS}/ps/person-token`,
      auth_token_endpoint: `${PS}/ps/token`,
    });
    const jwks = await (
      await ps.handle(new Request(`${PS}/.well-known/jwks.json`))
    ).json();
    expect(jwks.keys).toHaveLength(1);
  });

  it("runs a trip under one mission and its budget", async () => {
    const agent = await AgentClient.create();
    const trip = await approvedTrip(agent);
    expect(asked[0]).toMatchObject({
      kind: "mission",
      approver: { id: "dana" },
      person: { id: "sam" },
    });
    const bytes = Buffer.from(trip.mission, "base64url");
    expect(createHash("sha256").update(bytes).digest("base64url")).toBe(
      trip.s256,
    );
    expect(JSON.parse(bytes.toString())).toMatchObject({
      approved_resources: [RESOURCE],
      budget: { amount: 300_000 },
    });

    const presented = trip.person_tokens[RESOURCE]!;
    const person = (await jwtVerify(presented, createLocalJWKSet(ps.jwks())))
      .payload;
    expect(person).toMatchObject({
      aud: RESOURCE,
      mission_s256: trip.s256,
      tenant: "acme",
    });
    expect(person.sub).not.toBe("sam");

    // Within the budget: issued at once, and spent.
    const flight = await call(agent, "POST", "/ps/token", {
      resource_token: await resourceToken(agent, presented, 165_000),
      presented_token: presented,
    });
    expect(flight.status).toBe(200);
    const auth = decodeJwt(
      ((await flight.json()) as { auth_token: string }).auth_token,
    );
    expect(auth).toMatchObject({
      aud: RESOURCE,
      ps: PS,
      scope: "booking.reserve",
      budget: { amount: 165_000 },
    });

    // Over what is left: the approver is asked, with the resource's own summary.
    const hotel = await call(agent, "POST", "/ps/token", {
      resource_token: await resourceToken(agent, presented, 168_000),
      presented_token: presented,
    });
    expect(hotel.status).toBe(202);
    expect(asked.at(-1)).toMatchObject({
      kind: "auth_token",
      summary: "QT Sydney, 4 nights, $1,680",
    });
    await ps.decide(asked.at(-1)!.id, { status: "approved" });
    const granted = await call(
      agent,
      "GET",
      new URL(hotel.headers.get("location")!).pathname,
    );
    expect(granted.status).toBe(200);
    expect((await ps.mission(trip.s256))?.spent).toBe(333_000);

    // Completion is the person's to accept; nothing issues under the mission after.
    const done = await call(agent, "POST", `/ps/mission/${trip.s256}`, {
      action: "completion",
      summary: "Booked",
    });
    expect(done.status).toBe(202);
    expect(asked.at(-1)).toMatchObject({
      kind: "completion",
      approver: { id: "sam" },
    });
    await ps.decide(asked.at(-1)!.id, { status: "approved" });
    const again = await call(agent, "POST", "/ps/person-token", {
      resource: RESOURCE,
      mission_s256: trip.s256,
    });
    expect(again.status).toBe(403);
    expect(((await again.json()) as { error: string }).error).toBe(
      "mission_terminated",
    );
  });

  it("issues nothing outside a mission, and fetches no keys for a resource the mission does not cover", async () => {
    const agent = await AgentClient.create();
    const tokenResponse = await call(agent, "POST", "/ps/person-token", {
      resource: RESOURCE,
      login_hint: "sam@acme.example",
    });
    const { person_token } = (await tokenResponse.json()) as {
      person_token: string;
    };
    const refused = await call(agent, "POST", "/ps/token", {
      resource_token: await resourceToken(agent, person_token, 100),
      presented_token: person_token,
    });
    expect(refused.status).toBe(403);
  });

  it("binds an agent key to one person, and a pending request to the key that asked", async () => {
    const agent = await AgentClient.create();
    const first = await call(agent, "POST", "/ps/person-token", {
      resource: RESOURCE,
      login_hint: "sam@acme.example",
    });
    expect(first.status).toBe(200);
    const other = await call(agent, "POST", "/ps/person-token", {
      resource: RESOURCE,
      login_hint: "dana@acme.example",
    });
    expect(other.status).toBe(403);

    const proposed = await call(agent, "POST", "/ps/mission", {
      description: "Trip",
      resources: [RESOURCE],
    });
    const stranger = await AgentClient.create();
    const peek = await call(
      stranger,
      "GET",
      new URL(proposed.headers.get("location")!).pathname,
    );
    expect(peek.status).toBe(404);
  });

  it("refuses an untrusted provider and a tampered body", async () => {
    const agent = await AgentClient.create();
    const outsider = await party("outsider");
    const untrusted = new AgentClient();
    untrusted.session = agent.session;
    untrusted.token = await outsider.sign(
      {
        iss: "https://other.example",
        dwk: "aauth-agent.json",
        sub: "aauth:x@other.example",
        cnf: { jwk: agent.session.publicJwk },
      },
      "aa-agent+jwt",
    );
    expect(
      (
        await call(untrusted, "POST", "/ps/person-token", {
          resource: RESOURCE,
        })
      ).status,
    ).toBe(401);

    const signed = await agent.request("POST", `${PS}/ps/person-token`, {
      resource: RESOURCE,
    });
    const tampered = new Request(signed.url, {
      method: "POST",
      headers: signed.headers,
      body: JSON.stringify({
        resource: RESOURCE,
        login_hint: "dana@acme.example",
      }),
    });
    expect((await ps.handle(tampered)).status).toBe(401);
  });

  it("serves the management routes only with the admin token", async () => {
    const agent = await AgentClient.create();
    await call(agent, "POST", "/ps/mission", {
      description: "Trip",
      resources: [RESOURCE],
      login_hint: "sam@acme.example",
    });
    expect((await ps.handle(new Request(`${PS}/ps/consent`))).status).toBe(401);
    const admin = { authorization: "Bearer admin" };
    const pending = (await (
      await ps.handle(
        new Request(`${PS}/ps/consent?status=pending`, { headers: admin }),
      )
    ).json()) as Approval[];
    expect(pending).toHaveLength(1);
    const decided = await ps.handle(
      new Request(`${PS}/ps/consent/${pending[0]!.id}/decision`, {
        method: "POST",
        headers: { ...admin, "Content-Type": "application/json" },
        body: JSON.stringify({
          decision: "approve",
          budget: { amount: 1000, ...USD },
        }),
      }),
    );
    expect(decided.status).toBe(200);
    const missions = (await (
      await ps.handle(new Request(`${PS}/ps/missions`, { headers: admin }))
    ).json()) as { s256: string }[];
    expect(missions).toHaveLength(1);
    const ended = await ps.handle(
      new Request(`${PS}/ps/missions/${missions[0]!.s256}`, {
        method: "PATCH",
        headers: admin,
      }),
    );
    expect(
      ((await ended.json()) as { completed_at?: number }).completed_at,
    ).toBeDefined();
  });
});
