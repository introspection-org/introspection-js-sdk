/**
 * The SDK walk's AAuth lane: a mission on the Data Plane's hosted Person
 * Server, its approvals answered through `client.approvals` as a customer's
 * approval app answers them, read back through `client.missions`, and the
 * auth and person tokens it earns at a resource.
 *
 * The walk plays the agent (`@aauth/agent`), the Agent Provider vouching for
 * it and the resource (`@introspection-sdk/aauth-resource`) itself, each at an
 * `https://*.localhost` name portless serves on :443. Live, it needs
 * `WALK_AAUTH=1`, portless on :443, and the plane's Person Server at
 * `https://ps.introspection.localhost` trusting `https://aauth-agents.localhost`
 * (cloud's `scripts/compose-scenarios.sh` `aauth_person_server`). Replay needs
 * only the committed recording: every signature and token rides a header,
 * which the recording does not match on, so nothing listens then.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Polly } from "@pollyjs/core";
import { IntrospectionClient } from "@introspection-sdk/introspection-node";
import type { Project } from "@introspection-sdk/introspection-node";
import type { Approval } from "@introspection-sdk/types";
import {
  createAAuthFetch,
  createSignedFetch,
  pollDeferred,
} from "@aauth/agent";
import { createAAuthResource } from "@introspection-sdk/aauth-resource";
import { exportJWK, importPKCS8, SignJWT, type JWK } from "jose";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getPollyMode, setupPolly } from "../polly-setup";
import { BOOTSTRAP_FILE, NATIVE_FETCH, Steps, walkSettings } from "./support";
import type { WalkSettings } from "./support";

const RECORDING = "aauth-walk";
const STEP_TIMEOUT = 5 * 60_000;
const POLL_SECONDS = 60;
const RECORDINGS_DIR =
  process.env.POLLY_RECORDINGS_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../recordings");
const mode = getPollyMode();

const AAUTH = {
  personServer:
    process.env.WALK_AAUTH_PERSON_SERVER ??
    "https://ps.introspection.localhost",
  agentProvider: "https://aauth-agents.localhost",
  agentProviderPort: 3497,
  resource: "https://aauth-resource.localhost",
  resourcePort: 3496,
  portless: "portless@0.15.11",
  scope: "walk.act",
  budgetCents: 3000,
} as const;
const USD = { unit: "USD", decimals: 2 } as const;

const recorded = fs.existsSync(
  `${RECORDINGS_DIR}/${RECORDING}/${BOOTSTRAP_FILE}`,
);
const runnable = mode === "replay" ? recorded : process.env.WALK_AAUTH === "1";
const lane = runnable ? describe.sequential : describe.skip;

interface PersonServerMetadata {
  issuer: string;
  jwks_uri: string;
  mission_endpoint: string;
  person_token_endpoint: string;
  auth_token_endpoint: string;
}

type KeyMaterial = () => Promise<{
  signingKey: JWK;
  signatureKey: { type: "jwt"; jwt: string };
}>;

interface Agent {
  fetch: typeof fetch;
  keyMaterial: KeyMaterial;
}

/** A key kept across runs: the Person Server caches an issuer's keys. */
function keptKey(file: string): string {
  const at = path.join(tmpdir(), file);
  if (fs.existsSync(at)) return fs.readFileSync(at, "utf8");
  const pem = generateKeyPairSync("ed25519")
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
  fs.writeFileSync(at, pem, { mode: 0o600 });
  return pem;
}

function route(url: string, port: number): void {
  const name = new URL(url).hostname.replace(/\.localhost$/, "");
  const alias = spawnSync(
    "npx",
    ["-y", AAUTH.portless, "alias", name, String(port), "--force"],
    { encoding: "utf8" },
  );
  if (alias.status !== 0)
    throw new Error(`portless alias ${name}: ${alias.stderr || alias.stdout}`);
}

async function read(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function serve(
  port: number,
  handle: (req: IncomingMessage, body: string) => Promise<Response>,
): Promise<Server> {
  const server = createServer((req, res) => {
    void read(req)
      .then((body) => handle(req, body))
      .catch((error: unknown) =>
        Response.json({ error: String(error) }, { status: 500 }),
      )
      .then(async (response) => {
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/** The request as its public URL names it, which is what the signature covers. */
function asRequest(req: IncomingMessage, origin: string, body: string) {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers))
    if (value !== undefined)
      headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  return new Request(`${origin}${req.url}`, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
}

/** The Agent Provider and the resource, behind their portless names. */
async function startParties(): Promise<Server[]> {
  route(AAUTH.agentProvider, AAUTH.agentProviderPort);
  route(AAUTH.resource, AAUTH.resourcePort);
  const providerJwk = {
    ...(await exportJWK(await providerKey())),
    kid: "aauth-walk-1",
    alg: "Ed25519",
  };
  delete providerJwk.d;
  const provider = await serve(AAUTH.agentProviderPort, async (req) =>
    req.url === "/.well-known/aauth-agent.json"
      ? Response.json({
          issuer: AAUTH.agentProvider,
          jwks_uri: `${AAUTH.agentProvider}/jwks.json`,
          name: "SDK walk",
        })
      : req.url === "/jwks.json"
        ? Response.json({ keys: [providerJwk] })
        : Response.json({}, { status: 404 }),
  );
  const resource = await createAAuthResource({
    issuer: AAUTH.resource,
    name: "SDK walk resource",
    scopes: { [AAUTH.scope]: "Act for the walk, at the price named" },
    budgetUnits: [{ unit: USD.unit, decimals: USD.decimals }],
    personServers: [AAUTH.personServer],
    agentProviders: [AAUTH.agentProvider],
    // Its own discovery stays out of the recording.
    fetch: NATIVE_FETCH,
    signingKey: keptKey("aauth-walk-resource.pem"),
    kid: "aauth-walk-resource-1",
  });
  const act = await serve(AAUTH.resourcePort, async (req, body) => {
    const request = asRequest(req, AAUTH.resource, body);
    const served = await resource.handle(request);
    if (served) return served;
    if (req.url !== "/v1/act" || req.method !== "POST")
      return Response.json({}, { status: 404 });
    const { amount, label } = JSON.parse(body || "{}") as {
      amount: number;
      label: string;
    };
    const authz = await resource.authorize(
      request,
      body,
      {
        scope: AAUTH.scope,
        operation: { action: "act" },
        parameters: { label },
        summary: `${label} for $${(amount / 100).toFixed(2)}`,
        budget: { amount, ...USD },
      },
      { url: `${AAUTH.resource}/v1/act` },
    );
    if (!authz.ok) return authz.response;
    return Response.json({ ok: true, mission_s256: authz.mission_s256 });
  });
  return [provider, act];
}

let providerKeyCache: Promise<CryptoKey> | undefined;
const providerKey = () =>
  (providerKeyCache ??= importPKCS8(
    keptKey("aauth-walk-agent-provider.pem"),
    "Ed25519",
    { extractable: true },
  ) as Promise<CryptoKey>);

/** An agent: a fresh session key and an agent token binding it. */
async function newAgent(): Promise<Agent> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signingKey = {
    ...privateKey.export({ format: "jwk" }),
    alg: "Ed25519",
  } as JWK;
  const iat = Math.floor(Date.now() / 1000);
  const jwt = await new SignJWT({
    iss: AAUTH.agentProvider,
    dwk: "aauth-agent.json",
    sub: `aauth:walk-${randomUUID().slice(0, 8)}@${new URL(AAUTH.agentProvider).hostname}`,
    ps: AAUTH.personServer,
    jti: randomUUID(),
    iat,
    exp: iat + 3600,
    cnf: {
      jwk: { ...publicKey.export({ format: "jwk" }), alg: "Ed25519" },
    },
  })
    .setProtectedHeader({
      alg: "Ed25519",
      typ: "aa-agent+jwt",
      kid: "aauth-walk-1",
    })
    .sign(await providerKey());
  const keyMaterial: KeyMaterial = async () => ({
    signingKey,
    signatureKey: { type: "jwt", jwt },
  });
  return {
    fetch: createSignedFetch(keyMaterial, { signBody: true }) as typeof fetch,
    keyMaterial,
  };
}

lane("SDK walk: AAuth on the hosted Person Server", () => {
  const steps = new Steps();
  let polly: Polly;
  let settings: WalkSettings;
  let member: IntrospectionClient;
  let project: Project;
  let parties: Server[] = [];
  let tenant: string;
  let ps: PersonServerMetadata;
  let agent: Agent;
  let mission: { s256: string; mission: string };

  const person = () => `walk-${settings.run}@example.com`;
  const identity = () => ({ login_hint: `user:${person()}`, tenant });

  async function missionCall(url: string, body: Record<string, unknown>) {
    return agent.fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function settle(url: string, pending: Response) {
    if (pending.status !== 202) return { response: pending, error: undefined };
    return pollDeferred({
      signedFetch: agent.fetch,
      locationUrl: new URL(pending.headers.get("location")!, url).toString(),
      maxPollDuration: POLL_SECONDS,
    });
  }

  /** The pending approval of `kind` a check names: by description, or by the mission it is for. */
  async function pendingApproval(
    kind: "mission" | "auth_token" | "completion",
    named: { description: string } | { s256: string },
  ): Promise<Approval> {
    const deadline = Date.now() + POLL_SECONDS * 1000;
    let missionId: string | undefined;
    for (;;) {
      if ("s256" in named && !missionId)
        for await (const m of member.missions.list())
          if (m.s256 === named.s256) missionId = m.id;
      for await (const a of member.approvals.list({
        status: ["pending"],
        kind,
        ...(missionId ? { mission_id: missionId } : {}),
      }))
        if (
          "description" in named
            ? a.description === named.description
            : Boolean(missionId)
        )
          return a;
      if (Date.now() > deadline)
        throw new Error(
          `no pending ${kind} approval for ${JSON.stringify(named)}`,
        );
      await new Promise((resolve) =>
        setTimeout(resolve, mode === "replay" ? 0 : 500),
      );
    }
  }

  function act(amount: number, label: string) {
    const fetchAs = createAAuthFetch({
      getKeyMaterial: agent.keyMaterial,
      personServerUrl: AAUTH.personServer,
      loginHint: identity().login_hint,
      tenant,
      missionS256: mission.s256,
      maxPollDuration: POLL_SECONDS,
    });
    return fetchAs(`${AAUTH.resource}/v1/act`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount, label }),
    });
  }

  beforeAll(async () => {
    polly = setupPolly({ recordingName: RECORDING, ordered: true });
    settings = walkSettings(mode);
    if (mode === "replay") {
      const bootstrap = JSON.parse(
        fs.readFileSync(
          `${RECORDINGS_DIR}/${RECORDING}/${BOOTSTRAP_FILE}`,
          "utf8",
        ),
      ) as { project_id: string; run: string };
      settings = {
        ...settings,
        bootstrapProjectId: bootstrap.project_id,
        run: bootstrap.run,
      };
    } else {
      parties = await startParties();
    }
    agent = await newAgent();
  }, STEP_TIMEOUT);

  afterAll(async () => {
    for (const server of parties) server.close();
    await polly?.stop();
  }, STEP_TIMEOUT);

  it(
    "0: the login's project, and its member on the Data Plane",
    async (ctx) => {
      await steps.run(ctx, "setup", async () => {
        const owner = new IntrospectionClient({
          cpSession: settings.cpSession,
          advanced: { baseApiUrl: settings.baseApiUrl },
        });
        project = await owner.projects.get(settings.bootstrapProjectId!);
        if (mode === "record") {
          fs.mkdirSync(`${RECORDINGS_DIR}/${RECORDING}`, { recursive: true });
          fs.writeFileSync(
            `${RECORDINGS_DIR}/${RECORDING}/${BOOTSTRAP_FILE}`,
            JSON.stringify({ project_id: project.id, run: settings.run }) +
              "\n",
          );
        }
        const minted = await owner.tokens.create({
          project: project.id,
          expires_hours: 24,
        });
        member = new IntrospectionClient({
          token: minted.access_token,
          advanced: {
            baseApiUrl: settings.baseApiUrl,
            dpUrl: settings.dpUrl ?? undefined,
          },
        });
        tenant = `${project.org_id}:${project.id}`;
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "1: discovery — the Person Server's metadata and signing keys",
    async (ctx) => {
      await steps.run(ctx, "discovery", async () => {
        const response = await fetch(
          `${AAUTH.personServer}/.well-known/aauth-person.json`,
        );
        expect(response.status).toBe(200);
        ps = (await response.json()) as PersonServerMetadata;
        expect(ps.issuer).toBe(AAUTH.personServer);
        for (const endpoint of [
          ps.mission_endpoint,
          ps.person_token_endpoint,
          ps.auth_token_endpoint,
        ])
          expect(endpoint).toMatch(
            new RegExp(`^${AAUTH.personServer}/v1/aauth/person-server/`),
          );
        const jwks = (await (await fetch(ps.jwks_uri)).json()) as {
          keys: unknown[];
        };
        expect(jwks.keys.length).toBeGreaterThan(0);
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "2: a mission — proposed, approved with a budget, and read back",
    async (ctx) => {
      await steps.run(ctx, "mission", async () => {
        const description = `SDK walk mission ${settings.run}`;
        const pending = await missionCall(ps.mission_endpoint, {
          description,
          resources: [AAUTH.resource],
          ...identity(),
        });
        expect(pending.status).toBe(202);
        const approval = await pendingApproval("mission", { description });
        expect(approval.kind).toBe("mission");
        expect((await member.approvals.get(approval.id)).status).toBe(
          "pending",
        );
        const decided = await member.approvals.update(approval.id, {
          status: "approved",
          budget: { amount: AAUTH.budgetCents, ...USD },
          decided_by: {
            identity: { user_id: `walk-approver-${settings.run}` },
          },
        });
        expect(decided.status).toBe("approved");
        const { response, error } = await settle(ps.mission_endpoint, pending);
        expect(error, JSON.stringify(error)).toBeUndefined();
        mission = (await response!.json()) as typeof mission;
        const bytes = Buffer.from(mission.mission, "base64url");
        expect(createHash("sha256").update(bytes).digest("base64url")).toBe(
          mission.s256,
        );
        let row: { id: string } | undefined;
        for await (const m of member.missions.list())
          if (m.s256 === mission.s256) row = m;
        expect(row, "the missions list shows it").toBeTruthy();
        const read = await member.missions.get(row!.id);
        expect(read.budget?.amount).toBe(AAUTH.budgetCents);
        expect(read.resources).toContain(AAUTH.resource);
        expect(read.completed_at ?? null).toBeNull();
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "3: within the budget, the resource is reached with no one asked",
    async (ctx) => {
      await steps.run(ctx, "within budget", async () => {
        const response = await act(500, `within ${settings.run}`);
        const body = (await response.json()) as {
          ok?: boolean;
          mission_s256?: string;
        };
        expect(response.status, JSON.stringify(body)).toBe(200);
        expect(body.mission_s256).toBe(mission.s256);
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "4: over what is left of the budget, the person is asked again",
    async (ctx) => {
      await steps.run(ctx, "over budget", async () => {
        const call = act(AAUTH.budgetCents, `over ${settings.run}`);
        const approval = await pendingApproval("auth_token", {
          s256: mission.s256,
        });
        expect(approval.resource).toBe(AAUTH.resource);
        await member.approvals.update(approval.id, {
          status: "approved",
          decided_by: {
            identity: { user_id: `walk-approver-${settings.run}` },
          },
        });
        const response = await call;
        expect(response.status).toBe(200);
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "5: a person token, then the mission completes and refuses another",
    async (ctx) => {
      await steps.run(ctx, "completion", async () => {
        const personToken = () =>
          agent.fetch(ps.person_token_endpoint, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              resource: AAUTH.resource,
              mission_s256: mission.s256,
              ...identity(),
            }),
          });
        expect((await personToken()).status).toBe(200);
        const completion = `${ps.mission_endpoint}/${mission.s256}`;
        const pending = await missionCall(completion, {
          action: "completion",
          summary: `SDK walk done ${settings.run}`,
          tenant,
        });
        if (pending.status === 202) {
          const approval = await pendingApproval("completion", {
            s256: mission.s256,
          });
          // Only the person the mission is for accepts its completion.
          await member.approvals.update(approval.id, {
            status: "approved",
            decided_by: { identity: { user_id: person() } },
          });
        }
        const { response, error } = await settle(completion, pending);
        expect(error, JSON.stringify(error)).toBeUndefined();
        expect(response?.status).toBe(200);
        expect((await personToken()).status).toBe(403);
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "6: a mission the person denies never starts",
    async (ctx) => {
      await steps.run(ctx, "denied", async () => {
        const description = `SDK walk mission ${settings.run} (denied)`;
        const pending = await missionCall(ps.mission_endpoint, {
          description,
          resources: [AAUTH.resource],
          ...identity(),
        });
        expect(pending.status).toBe(202);
        const approval = await pendingApproval("mission", { description });
        await member.approvals.update(approval.id, {
          status: "denied",
          decided_by: {
            identity: { user_id: `walk-approver-${settings.run}` },
          },
        });
        const { response, error } = await settle(ps.mission_endpoint, pending);
        expect(Boolean(error) || response?.ok === false).toBe(true);
      });
    },
    STEP_TIMEOUT,
  );
});
