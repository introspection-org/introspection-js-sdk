/**
 * REST control-plane coverage — driven against a REAL in-process HTTP server.
 *
 * No mocks: we stand up an actual `node:http` server on loopback, point the
 * `IntrospectionClient` at it via `advanced.baseApiUrl`, and let the global
 * `fetch` make real round-trips. This exercises the genuine
 * serialize → HTTP → parse paths through `client.ts`, `http.ts`,
 * `resources/{runtimes,experiments,recipes}.ts`, and `runner.ts` (the
 * control-plane surface that previously had ~0% coverage).
 *
 * The `/run` routes return a `RunnerSpec` whose `deployment.endpoint` points
 * back at the same server, so Data-Plane runner calls hit it too.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { AddressInfo } from "node:net";
import {
  IntrospectionClient,
  authorizationCodeToken,
  serviceAccountToken,
  tokenExchange,
} from "@introspection-sdk/introspection-node";
import {
  NotFoundError,
  RunnerExpiredError,
  ValidationError,
} from "@introspection-sdk/types";

interface CapturedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string | undefined;
  body: unknown;
}

const RUNTIME = {
  id: "11111111-1111-1111-1111-111111111111",
  org_id: "org-1",
  project_id: "proj-1",
  runtime_group_id: "33333333-3333-3333-3333-333333333333",
  name: "Customer Agent",
  slug: "customer-agent",
  recipe_id: "rec-1",
  is_active: true,
  llm_mode: "proxy",
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
};

const EXPERIMENT = {
  id: "22222222-2222-2222-2222-222222222222",
  org_id: "org-1",
  project_id: "proj-1",
  name: "exp-a",
  status: "draft",
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
};

const RECIPE = {
  id: "33333333-3333-3333-3333-333333333333",
  org_id: "org-1",
  project_id: "proj-1",
  repository_id: "repo-1",
  git_ref: "main",
  git_commit_sha: "abc123",
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
};

const CONNECTOR = {
  id: "44444444-4444-4444-4444-444444444444",
  org_id: "org-1",
  project_id: "proj-1",
  created_at: "2026-08-08T00:00:00Z",
  updated_at: "2026-08-08T00:00:00Z",
  slug: "slack-support",
  name: "Slack (support)",
  provider: "slack",
  auth_mode: "oauth_stored",
  environment: "production",
  scopes: ["chat:write"],
  api_hosts: ["slack.com"],
  approval_policy: "human",
  status: "active",
  requires_runtime: true,
};

const CONNECTION = {
  id: "55555555-5555-5555-5555-555555555555",
  org_id: "org-1",
  created_at: "2026-08-08T00:00:00Z",
  updated_at: "2026-08-08T00:00:00Z",
  connector_id: CONNECTOR.id,
  member_id: "member-1",
  created_by_member_id: "installer-1",
  runtime_group_id: "rg-1",
  subject_type: "workspace",
  scopes_granted: ["chat:write"],
  status: "active",
  token_expires_at: null,
};

const DISABLED_CONNECTOR_ID = "66666666-6666-6666-6666-666666666666";

function runnerSpec(endpoint: string, generation = 1) {
  return {
    session_id: `sess-${generation}`,
    deployment: { endpoint, slug: "gcp01", region: "us-east-1" },
    session_token: `runner-jwt-${generation}`,
    expires_at: "2025-01-01T01:00:00Z",
    runtime_context: {
      runtime_id: RUNTIME.id,
      runtime_group_id: RUNTIME.runtime_group_id,
      experiment_id: null,
      recipe_id: RECIPE.id,
      recipe_repository_id: "repo-1",
      recipe_git_ref: "main",
      recipe_git_commit_sha: "abc123",
      recipe: {
        repository_id: "repo-1",
        git_ref: "main",
        git_commit_sha: "abc123",
      },
      arm_label: null,
      agent_name: "agent",
      identity: {},
    },
  };
}

let server: Server;
let baseUrl: string;
let requests: CapturedRequest[] = [];
/** Bumped per `/v1/runtimes/{id}/run`, so each mint is distinguishable. */
let runGeneration = 0;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
  });
}

function json(
  res: import("node:http").ServerResponse,
  status: number,
  payload: unknown,
) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const body = await readBody(req);
    requests.push({
      method,
      path,
      query: url.searchParams,
      auth: req.headers.authorization,
      body,
    });

    const page = (records: unknown[], next: string | null = null) => ({
      records,
      count: records.length,
      total_count: records.length,
      next,
    });

    // --- Control-plane: OAuth token endpoint (machine + federated grants) ---
    if (path === "/v1/oauth/token" && method === "POST") {
      const form = new URLSearchParams(typeof body === "string" ? body : "");
      const grant = form.get("grant_type");
      const ok =
        (grant === "client_credentials" &&
          form.get("client_id") === "intro_app_test" &&
          form.get("client_secret") === "intro_sk_test" &&
          !!form.get("project")) ||
        (grant === "urn:ietf:params:oauth:grant-type:token-exchange" &&
          !!form.get("subject_token") &&
          !!form.get("client_id")) ||
        (grant === "authorization_code" &&
          !!form.get("code") &&
          !!form.get("code_verifier") &&
          !!form.get("client_id"));
      if (!ok) {
        return json(res, 400, {
          detail: "Invalid client credentials",
          code: "invalid_client",
        });
      }
      return json(res, 200, {
        access_token: `minted-${grant === "client_credentials" ? "sa" : grant === "authorization_code" ? "code" : "exchange"}-token`,
        token_type: "Bearer",
        expires_in: 3600,
        scope: form.get("scope"),
        dp_url: "https://dp.example.com",
      });
    }

    // --- Control-plane: runtimes ---
    if (path === "/v1/runtimes" && method === "GET") {
      // resolve path: ?runtime=... returns a match; pagination via ?next=
      const runtime = url.searchParams.get("runtime");
      if (
        runtime &&
        runtime !== RUNTIME.slug &&
        runtime !== RUNTIME.runtime_group_id
      )
        return json(res, 200, page([]));
      // Two-page pagination when paginate=1 and no cursor yet.
      if (
        url.searchParams.get("paginate") === "1" &&
        !url.searchParams.get("next")
      ) {
        return json(res, 200, page([RUNTIME], "cursor-2"));
      }
      if (url.searchParams.get("next") === "cursor-2") {
        return json(res, 200, page([{ ...RUNTIME, id: "rt-2" }], null));
      }
      return json(res, 200, page([RUNTIME]));
    }
    if (path === `/v1/runtimes/${RUNTIME.id}` && method === "GET")
      return json(res, 200, RUNTIME);
    if (path === `/v1/runtimes/${RUNTIME.id}/run` && method === "POST")
      return json(res, 200, runnerSpec(baseUrl, ++runGeneration));

    // --- Control-plane: experiments ---
    if (path === "/v1/experiments" && method === "GET")
      return json(res, 200, page([EXPERIMENT]));
    if (path === "/v1/experiments" && method === "POST")
      return json(res, 201, EXPERIMENT);
    if (path === `/v1/experiments/${EXPERIMENT.id}` && method === "GET")
      return json(res, 200, EXPERIMENT);
    if (path === `/v1/experiments/${EXPERIMENT.id}` && method === "PATCH")
      return json(res, 200, { ...EXPERIMENT, name: "exp-renamed" });
    if (path === `/v1/experiments/${EXPERIMENT.id}` && method === "DELETE") {
      res.writeHead(204);
      return res.end();
    }
    if (path === `/v1/experiments/${EXPERIMENT.id}/start` && method === "POST")
      return json(res, 200, { ...EXPERIMENT, status: "running" });
    if (path === `/v1/experiments/${EXPERIMENT.id}/end` && method === "POST")
      return json(res, 200, { ...EXPERIMENT, status: "completed" });
    if (path === `/v1/experiments/${EXPERIMENT.id}/cancel` && method === "POST")
      return json(res, 200, { ...EXPERIMENT, status: "cancelled" });
    if (path === `/v1/experiments/${EXPERIMENT.id}/run` && method === "POST")
      return json(res, 200, runnerSpec(baseUrl));

    // --- Control-plane: recipes ---
    if (path === "/v1/recipes" && method === "GET")
      return json(res, 200, page([RECIPE]));
    if (path === "/v1/recipes" && method === "POST")
      return json(res, 201, RECIPE);
    if (path === `/v1/recipes/${RECIPE.id}` && method === "GET")
      return json(res, 200, RECIPE);
    if (path === `/v1/recipes/${RECIPE.id}` && method === "PATCH")
      return json(res, 200, { ...RECIPE, git_ref: "release" });
    if (path === `/v1/recipes/${RECIPE.id}` && method === "DELETE") {
      res.writeHead(204);
      return res.end();
    }

    // --- Control-plane: connectors + nested connections ---
    if (path === "/v1/connectors" && method === "GET")
      return json(res, 200, page([CONNECTOR]));
    if (path === "/v1/connectors" && method === "POST")
      return json(res, 201, CONNECTOR);
    if (path === `/v1/connectors/${CONNECTOR.id}` && method === "GET")
      return json(res, 200, CONNECTOR);
    if (path === `/v1/connectors/${CONNECTOR.id}` && method === "PATCH")
      return json(res, 200, { ...CONNECTOR, name: "Slack (renamed)" });
    if (path === `/v1/connectors/${CONNECTOR.id}` && method === "DELETE") {
      res.writeHead(204);
      return res.end();
    }
    if (
      path === `/v1/connectors/${CONNECTOR.id}/connections` &&
      method === "GET"
    )
      return json(res, 200, page([CONNECTION]));
    if (
      path === `/v1/connectors/${CONNECTOR.id}/connections` &&
      method === "POST"
    )
      return json(res, 201, CONNECTION);
    if (
      path === `/v1/connectors/${CONNECTOR.id}/connections/${CONNECTION.id}` &&
      method === "GET"
    )
      return json(res, 200, CONNECTION);
    if (
      path === `/v1/connectors/${CONNECTOR.id}/connections/${CONNECTION.id}` &&
      method === "DELETE"
    ) {
      res.writeHead(204);
      return res.end();
    }
    // The connector whose slug names a deployment with the feature flag off.
    if (path === `/v1/connectors/${DISABLED_CONNECTOR_ID}`)
      return json(res, 404, { detail: "Connectors are not enabled" });
    if (path === "/v1/oauth/connections/authorize" && method === "POST") {
      const sent = body as Record<string, unknown>;
      // A chat provider must name the agent that replies (server-side 422).
      if (!sent.runtime) {
        return json(res, 422, {
          detail:
            "`runtime` is required for a slack connector — it names the agent that replies",
        });
      }
      const expiresIn = (sent.expires_in as number) ?? 600;
      return json(res, 200, {
        authorize_url: `https://slack.com/oauth/v2/authorize?client_id=abc&state=single-use-${expiresIn}`,
        expires_in: expiresIn,
        expires_at: "2026-08-08T21:00:00Z",
      });
    }

    // --- Data-plane (runner) ---
    if (path === "/v1/tasks" && method === "GET")
      return json(res, 200, page([{ id: "task-1", name: "t" }]));

    json(res, 404, { detail: "not found", code: "not_found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

// Each test gets its own mint counter, so `sess-1` always means "the first
// session this test opened".
beforeEach(() => {
  runGeneration = 0;
});

function makeClient() {
  return new IntrospectionClient({
    token: "test-token",
    advanced: { baseApiUrl: baseUrl },
  });
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

describe("IntrospectionClient (REST control-plane, real server)", () => {
  it("sends the bearer token and resolves base URL", async () => {
    requests = [];
    const client = makeClient();
    await collect(client.runtimes.list({ project: "proj-1" }));
    expect(requests[0].auth).toBe("Bearer test-token");
    expect(requests[0].path).toBe("/v1/runtimes");
    await client.shutdown();
  });

  it("warns but constructs when no token is supplied", () => {
    const prev = process.env.INTROSPECTION_TOKEN;
    delete process.env.INTROSPECTION_TOKEN;
    const client = new IntrospectionClient({
      advanced: { baseApiUrl: baseUrl },
    });
    expect(client).toBeInstanceOf(IntrospectionClient);
    if (prev !== undefined) process.env.INTROSPECTION_TOKEN = prev;
  });

  describe("runtimes", () => {
    it("does not expose runtime operator mutations", () => {
      const client = makeClient();
      expect(client.runtimes).not.toHaveProperty("create");
      expect(client.runtimes).not.toHaveProperty("update");
      expect(client.runtimes).not.toHaveProperty("delete");
      expect(client.runtimes).not.toHaveProperty("yank");
      expect(client.runtimes).not.toHaveProperty("unyank");
      expect(client.runtimes).not.toHaveProperty("activateById");

      const handle = client.runtimes("customer-agent");
      expect(handle).not.toHaveProperty("pin");
      expect(handle).not.toHaveProperty("activate");
    });

    it("lists and gets runtimes", async () => {
      const client = makeClient();
      const listed = await collect(client.runtimes.list({ project: "proj-1" }));
      expect(listed[0].name).toBe("Customer Agent");

      const got = await client.runtimes.get(RUNTIME.id, {
        project: "proj-1",
      });
      expect(got.id).toBe(RUNTIME.id);
    });

    it("list paginates across pages", async () => {
      const client = makeClient();
      const ids: string[] = [];
      for await (const r of client.runtimes.list({
        project: "proj-1",
        paginate: 1,
      } as never)) {
        ids.push(r.id);
      }
      expect(ids).toEqual([RUNTIME.id, "rt-2"]);
    });

    it("resolve returns the match, throws NotFoundError otherwise", async () => {
      const client = makeClient();
      const found = await client.runtimes.resolve(RUNTIME.slug, "proj-1");
      expect(found.id).toBe(RUNTIME.id);
      await expect(
        client.runtimes.resolve("does-not-exist", "proj-1"),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("handle resolves a runtime slug lazily then runs", async () => {
      requests = [];
      const client = makeClient();
      const runner = await client.runtimes("customer-agent").run({
        identity: { user_id: "u-1" },
        caller: { locale: "en-US" },
        agent_name: "specialist",
        scope: "tasks:read tasks:write",
      });
      // First request resolves the runtime, second opens the runner.
      expect(
        requests.some(
          (r) =>
            r.path === "/v1/runtimes" &&
            r.query.get("runtime") === "customer-agent",
        ),
      ).toBe(true);
      const runReq = requests.find((r) => r.path.endsWith("/run"));
      expect(
        (runReq?.body as { identity?: { user_id?: string } })?.identity
          ?.user_id,
      ).toBe("u-1");
      expect(runReq?.body).toMatchObject({
        caller: { locale: "en-US" },
        agent_name: "specialist",
        scope: "tasks:read tasks:write",
      });
      expect(runner.context.runtime_group_id).toBe(RUNTIME.runtime_group_id);
      expect(runner.context.agent_name).toBe("agent");
      expect(runner.session_id).toBe("sess-1");
    });
  });

  describe("service account auth", () => {
    it("mints a token via client_credentials (form-encoded)", async () => {
      requests = [];
      const tok = await serviceAccountToken({
        clientId: "intro_app_test",
        clientSecret: "intro_sk_test",
        project: "proj-1",
        scope: "runtimes:read runtimes:run",
        baseApiUrl: baseUrl,
      });
      expect(tok.access_token).toBe("minted-sa-token");
      expect(tok.expires_in).toBe(3600);
      expect(tok.scope).toBe("runtimes:read runtimes:run");

      const tokenReq = requests.find((r) => r.path === "/v1/oauth/token");
      expect(tokenReq?.method).toBe("POST");
      // Form-encoded, unauthenticated (credentials travel in the body).
      expect(tokenReq?.auth).toBeUndefined();
      expect(tokenReq?.body).toContain("grant_type=client_credentials");
    });

    it("tokenExchange and authorizationCodeToken surface dp_url", async () => {
      const exchanged = await tokenExchange({
        subjectToken: "idp-id-token",
        clientId: "intro_app_federated",
        project: "proj-1",
        baseApiUrl: baseUrl,
      });
      expect(exchanged.access_token).toBe("minted-exchange-token");
      expect(exchanged.dp_url).toBe("https://dp.example.com");

      const coded = await authorizationCodeToken({
        code: "auth-code",
        clientId: "intro_app_spa",
        redirectUri: "http://localhost:3200/callback",
        codeVerifier: "verifier",
        baseApiUrl: baseUrl,
      });
      expect(coded.access_token).toBe("minted-code-token");
      expect(coded.dp_url).toBe("https://dp.example.com");
    });

    it("maps bad credentials to a typed ValidationError", async () => {
      await expect(
        serviceAccountToken({
          clientId: "intro_app_test",
          clientSecret: "wrong",
          project: "proj-1",
          baseApiUrl: baseUrl,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("fromServiceAccount mints then resolves a runtime slug", async () => {
      requests = [];
      const client = await IntrospectionClient.fromServiceAccount({
        clientId: "intro_app_test",
        clientSecret: "intro_sk_test",
        project: "proj-1",
        baseApiUrl: baseUrl,
      });
      const runner = await client.runtimes(RUNTIME.slug).run({
        identity: { user_id: "u_demo" },
      });
      expect(runner.context.runtime_id).toBe(RUNTIME.id);

      // The minted token is the bearer on the subsequent CP calls.
      const runtimeCall = requests.find((r) =>
        r.path.endsWith(`/runtimes/${RUNTIME.id}/run`),
      );
      expect(runtimeCall?.auth).toBe("Bearer minted-sa-token");
      await runner.close();
    });
  });

  describe("experiments", () => {
    it("uses the stable runtime selector on list", async () => {
      const client = makeClient();
      requests = [];

      await collect(
        client.experiments.list({
          project: "proj-1",
          runtime: RUNTIME.slug,
        }),
      );
      expect(requests[0]?.query.get("runtime")).toBe(RUNTIME.slug);
    });

    it("read + lifecycle + run", async () => {
      const client = makeClient();
      expect(
        await collect(client.experiments.list({ project: "proj-1" })),
      ).toHaveLength(1);
      expect((await client.experiments.get(EXPERIMENT.id)).id).toBe(
        EXPERIMENT.id,
      );

      const handle = client.experiments(EXPERIMENT.id);
      expect((await handle.start()).status).toBe("running");
      expect((await handle.end()).status).toBe("completed");
      expect((await handle.cancel()).status).toBe("cancelled");
      requests = [];
      const runner = await handle.run({
        identity: { user_id: "u-2" },
        caller: { locale: "fr-FR" },
        agent_name: "researcher",
        scope: "tasks:read",
      });
      expect(runner.session_id).toBe("sess-1");
      expect(
        requests.find((r) => r.path === `/v1/experiments/${EXPERIMENT.id}/run`)
          ?.body,
      ).toMatchObject({
        identity: { user_id: "u-2" },
        caller: { locale: "fr-FR" },
        agent_name: "researcher",
        scope: "tasks:read",
      });
    });

    it("list paginates", async () => {
      const client = makeClient();
      const seen = [];
      for await (const e of client.experiments.list({
        project: "proj-1",
      }))
        seen.push(e.id);
      expect(seen).toEqual([EXPERIMENT.id]);
    });
  });

  describe("recipes", () => {
    it("get + list", async () => {
      const client = makeClient();
      expect(
        await collect(client.recipes.list({ project: "proj-1" })),
      ).toHaveLength(1);
      expect((await client.recipes.get(RECIPE.id)).id).toBe(RECIPE.id);
      const seen = [];
      for await (const r of client.recipes.list({ project: "proj-1" }))
        seen.push(r.id);
      expect(seen).toEqual([RECIPE.id]);
    });
  });

  it("run() forwards identity tags for the member it mints", async () => {
    requests = [];
    const client = makeClient();

    await client.runtimes(RUNTIME.runtime_group_id).run({
      identity: { user_id: "u_demo", tags: ["project:x"] },
    });

    const run = requests.find((r) => r.path.endsWith("/run"));
    expect(run?.body).toMatchObject({
      identity: { user_id: "u_demo", tags: ["project:x"] },
    });

    await client.shutdown();
  });

  describe("connectors", () => {
    it("round-trips CRUD and scopes reads by project", async () => {
      requests = [];
      const client = makeClient();

      const created = await client.connectors.create(
        {
          name: "Slack (support)",
          provider: "slack",
          auth_mode: "oauth_stored",
          scopes: ["chat:write"],
          client_secret: "secret-xyz",
        },
        { project: "proj-1" },
      );
      expect(created.slug).toBe("slack-support");
      // The write-only secret is accepted on the way in and never comes back.
      expect(created).not.toHaveProperty("client_secret");
      const createRequest = requests.find(
        (r) => r.path === "/v1/connectors" && r.method === "POST",
      );
      expect(createRequest?.query.get("project")).toBe("proj-1");

      expect(
        await collect(client.connectors.list({ project: "proj-1" })),
      ).toHaveLength(1);
      expect((await client.connectors.get(CONNECTOR.id)).id).toBe(CONNECTOR.id);
      expect(
        (
          await client.connectors.update(CONNECTOR.id, {
            name: "Slack (renamed)",
          })
        ).name,
      ).toBe("Slack (renamed)");
      await expect(
        client.connectors.delete(CONNECTOR.id),
      ).resolves.toBeUndefined();

      await client.shutdown();
    });

    it("mints an install link carrying both expiry forms and no state", async () => {
      const client = makeClient();

      const minted = await client.connectors.authorize(CONNECTOR.id, {
        runtime: "support-agent",
        expires_in: 3600,
      });

      expect(minted.authorize_url).toContain("https://slack.com/oauth");
      expect(minted.expires_in).toBe(3600);
      expect(minted.expires_at).toBe("2026-08-08T21:00:00Z");
      expect(minted).not.toHaveProperty("state");

      await client.shutdown();
    });

    it("surfaces the 422 for a chat connector authorized without a runtime", async () => {
      const client = makeClient();

      await expect(
        client.connectors.authorize(CONNECTOR.id),
      ).rejects.toMatchObject({
        status: 422,
        message:
          "`runtime` is required for a slack connector — it names the agent that replies",
      });
      await expect(client.connectors.authorize(CONNECTOR.id)).rejects.toThrow(
        ValidationError,
      );

      await client.shutdown();
    });

    it("surfaces 'Connectors are not enabled' rather than a bare not-found", async () => {
      const client = makeClient();

      await expect(
        client.connectors.get(DISABLED_CONNECTOR_ID),
      ).rejects.toMatchObject({
        status: 404,
        message: "Connectors are not enabled",
      });

      await client.shutdown();
    });

    it("lists and revokes connections under their connector", async () => {
      requests = [];
      const client = makeClient();

      const connections = await collect(
        client.connectors.connections.list(CONNECTOR.id),
      );
      expect(connections).toHaveLength(1);
      expect(connections[0].subject_type).toBe("workspace");
      expect(connections[0].created_by_member_id).toBe("installer-1");

      const registered = await client.connectors.connections.create(
        CONNECTOR.id,
        { access_token: "xoxb-token" },
      );
      expect(registered.connector_id).toBe(CONNECTOR.id);
      expect(registered).not.toHaveProperty("access_token");

      expect(
        (await client.connectors.connections.get(CONNECTOR.id, CONNECTION.id))
          .id,
      ).toBe(CONNECTION.id);

      await expect(
        client.connectors.connections.revoke(CONNECTOR.id, CONNECTION.id),
      ).resolves.toBeUndefined();
      expect(
        requests.find(
          (r) =>
            r.method === "DELETE" &&
            r.path ===
              `/v1/connectors/${CONNECTOR.id}/connections/${CONNECTION.id}`,
        ),
      ).toBeDefined();

      await client.shutdown();
    });
  });

  describe("runner (data-plane handle)", () => {
    it("exposes accessors, runs DP calls, refresh re-mints, close guards", async () => {
      const client = makeClient();
      const runner = await client.runtimes(RUNTIME.runtime_group_id).run({
        agent_name: "specialist",
        scope: "tasks:read",
      });

      expect(runner.dpEndpoint).toBe(baseUrl);
      expect(runner.deployment.slug).toBe("gcp01");
      expect(runner.expires_at).toBe("2025-01-01T01:00:00Z");
      expect(runner.session_id).toBe("sess-1");
      expect(runner.context.runtime_id).toBe(RUNTIME.id);
      expect(runner.isClosed).toBe(false);

      // DP call routes to deployment.endpoint with the runner JWT.
      requests = [];
      const tasks = await collect(runner.tasks.list());
      expect(tasks[0].id).toBe("task-1");
      expect(requests.find((r) => r.path === "/v1/tasks")?.auth).toBe(
        "Bearer runner-jwt-1",
      );

      // Manual escape hatch: refresh re-calls the CP /run route.
      await expect(runner.refresh()).resolves.toBeUndefined();
      expect(requests.find((r) => r.path.endsWith("/run"))?.body).toMatchObject(
        {
          agent_name: "specialist",
          scope: "tasks:read",
        },
      );
      expect(runner.session_id).toBe("sess-2");

      // ...and the namespaces follow it. The refresh used to replace the
      // spec while leaving the transport bound to the previous session, so
      // the accessors reported a fresh session that no request ever used --
      // and the usual reason to refresh is that the old bearer stopped
      // working.
      requests = [];
      await collect(runner.tasks.list());
      expect(requests.find((r) => r.path === "/v1/tasks")?.auth).toBe(
        "Bearer runner-jwt-2",
      );

      // After close, guarded HTTP rejects further DP calls. The guard
      // fires on first iteration of the lazy generator.
      await runner.close();
      expect(runner.isClosed).toBe(true);
      await expect(collect(runner.tasks.list())).rejects.toBeInstanceOf(
        RunnerExpiredError,
      );
      await expect(runner.refresh()).rejects.toBeInstanceOf(RunnerExpiredError);
    });
  });
});
