/**
 * REST control-plane coverage — driven against a REAL in-process HTTP server.
 *
 * No mocks: we stand up an actual `node:http` server on loopback, point the
 * `IntrospectionClient` at it via `advanced.baseApiUrl`, and let the global
 * `fetch` make real round-trips. This exercises the genuine
 * serialize → HTTP → parse paths through `client.ts`, `http.ts`,
 * the runtime/experiment runner openers and `runner.ts`.
 *
 * The `/run` routes return a `RunnerSpec` whose `deployment.endpoint` points
 * back at the same server, so Data-Plane runner calls hit it too.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { AddressInfo } from "node:net";
import {
  IntrospectionClient,
  authorizationCodeToken,
  serviceAccountToken,
  tokenExchange,
} from "@introspection-sdk/introspection-node";
import { RunnerExpiredError, ValidationError } from "@introspection-sdk/types";

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

function runnerSpec(endpoint: string) {
  return {
    session_id: "sess-1",
    deployment: { endpoint, slug: "gcp01", region: "us-east-1" },
    session_token: "runner-jwt",
    expires_at: "2025-01-01T01:00:00Z",
    runtime_context: {
      runtime_id: RUNTIME.id,
      runtime_group_id: RUNTIME.runtime_group_id,
      experiment_id: null,
      recipe_id: RECIPE.id,
      recipe_repository_id: "repo-1",
      recipe_git_ref: "main",
      recipe_git_commit_sha: "abc123",
      arm_label: null,
      agent_name: "agent",
      identity: {},
    },
  };
}

let server: Server;
let baseUrl: string;
let requests: CapturedRequest[] = [];

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
    if (path === "/v1/runtimes" && method === "POST")
      return json(res, 201, RUNTIME);
    if (path === `/v1/runtimes/${RUNTIME.id}` && method === "GET")
      return json(res, 200, RUNTIME);
    if (path === `/v1/runtimes/${RUNTIME.id}` && method === "PATCH")
      return json(res, 200, { ...RUNTIME, description: "updated" });
    if (path === `/v1/runtimes/${RUNTIME.id}` && method === "DELETE") {
      res.writeHead(204);
      return res.end();
    }
    if (path === `/v1/runtimes/${RUNTIME.id}/run` && method === "POST")
      return json(res, 200, runnerSpec(baseUrl));
    if (path === `/v1/runtimes/${RUNTIME.id}/activate` && method === "POST")
      return json(res, 200, { ...RUNTIME, is_active: true });

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

function makeClient() {
  return new IntrospectionClient({
    token: "test-token",
    project: "proj-1",
    advanced: { baseApiUrl: baseUrl },
  });
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}

describe("IntrospectionClient (REST control-plane, real server)", () => {
  it("sends the bearer token and resolves the runtime internally", async () => {
    requests = [];
    const client = makeClient();
    await client.runtime(RUNTIME.slug).run();
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

  describe("runtime", () => {
    it("resolves a runtime lazily and forwards the current run contract", async () => {
      requests = [];
      const client = makeClient();
      const runner = await client.runtime("customer-agent").run({
        identity: { user_id: "u-1" },
        caller: { locale: "en-US" },
        agent_name: "support",
        ttl_seconds: 900,
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
        agent_name: "support",
        ttl_seconds: 900,
        scope: "tasks:read tasks:write",
      });
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
      const runner = await client.runtime(RUNTIME.slug).run({
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

  describe("experiment", () => {
    it("opens a runner without exposing experiment lifecycle management", async () => {
      const client = makeClient();
      const runner = await client.experiment(EXPERIMENT.id).run({
        identity: { user_id: "u-2" },
        agent_name: "researcher",
        scope: "tasks:read tasks:write",
      });
      expect(runner.session_id).toBe("sess-1");
      expect(
        requests.find((r) => r.path === `/v1/experiments/${EXPERIMENT.id}/run`)
          ?.body,
      ).toMatchObject({
        agent_name: "researcher",
        scope: "tasks:read tasks:write",
      });
    });
  });

  describe("runner (data-plane handle)", () => {
    it("exposes accessors, runs DP calls, refresh re-mints, close guards", async () => {
      const client = makeClient();
      const runner = await client.runtime(RUNTIME.runtime_group_id).run();

      expect(runner.dpEndpoint).toBe(baseUrl);
      expect(runner.deployment.slug).toBe("gcp01");
      expect(runner.expires_at).toBe("2025-01-01T01:00:00Z");
      expect(runner.session_id).toBe("sess-1");
      expect(runner.context.runtime_id).toBe(RUNTIME.id);
      expect(runner.context.runtime_group_id).toBe(RUNTIME.runtime_group_id);
      expect(runner.context.recipe_repository_id).toBe("repo-1");
      expect(runner.context.agent_name).toBe("agent");
      expect(runner.isClosed).toBe(false);

      // DP call routes to deployment.endpoint with the runner JWT.
      requests = [];
      const tasks = await collect(runner.tasks.list());
      expect(tasks[0].id).toBe("task-1");
      expect(requests.find((r) => r.path === "/v1/tasks")?.auth).toBe(
        "Bearer runner-jwt",
      );

      // Manual escape hatch: refresh re-calls the CP /run route.
      await expect(runner.refresh()).resolves.toBeUndefined();

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
