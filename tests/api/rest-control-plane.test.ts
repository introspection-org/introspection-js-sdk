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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { AddressInfo } from "node:net";
import {
  IntrospectionClient,
  serviceAccountToken,
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
  name: "customer-agent",
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
      experiment_id: null,
      recipe_id: RECIPE.id,
      recipe: {
        repository_id: "repo-1",
        git_ref: "main",
        git_commit_sha: "abc123",
      },
      arm_label: null,
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

    // --- Control-plane: service-account auth (client_credentials) ---
    if (path === "/v1/oauth/token" && method === "POST") {
      const form = new URLSearchParams(typeof body === "string" ? body : "");
      if (
        form.get("grant_type") !== "client_credentials" ||
        form.get("client_id") !== "intro_app_test" ||
        form.get("client_secret") !== "intro_sk_test" ||
        !form.get("project_id")
      ) {
        return json(res, 400, {
          detail: "Invalid client credentials",
          code: "invalid_client",
        });
      }
      return json(res, 200, {
        access_token: "minted-sa-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: form.get("scope"),
        dp_url: "https://dp.example.com",
      });
    }

    // --- Control-plane: runtimes ---
    if (path === "/v1/runtimes" && method === "GET") {
      // resolveByName path: ?name=... returns a match; pagination via ?next=
      const name = url.searchParams.get("name");
      if (name && name !== RUNTIME.name) return json(res, 200, page([]));
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
    projectId: "proj-1",
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
    await collect(client.runtimes.list({ project_id: "proj-1" }));
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
    it("CRUD + activate", async () => {
      const client = makeClient();
      const listed = await collect(
        client.runtimes.list({ project_id: "proj-1" }),
      );
      expect(listed[0].name).toBe("customer-agent");

      const created = await client.runtimes.create({
        name: "customer-agent",
        recipe_id: "rec-1",
        project_id: "proj-1",
      } as never);
      expect(created.id).toBe(RUNTIME.id);

      const got = await client.runtimes.get(RUNTIME.id, {
        project_id: "proj-1",
      });
      expect(got.id).toBe(RUNTIME.id);

      const updated = await client.runtimes.update(RUNTIME.id, {
        description: "updated",
      } as never);
      expect(updated.description).toBe("updated");

      await expect(client.runtimes.delete(RUNTIME.id)).resolves.toBeUndefined();

      const activated = await client.runtimes.activateById(RUNTIME.id, {
        project_id: "proj-1",
      });
      expect(activated.is_active).toBe(true);
    });

    it("list paginates across pages", async () => {
      const client = makeClient();
      const ids: string[] = [];
      for await (const r of client.runtimes.list({
        project_id: "proj-1",
        paginate: 1,
      } as never)) {
        ids.push(r.id);
      }
      expect(ids).toEqual([RUNTIME.id, "rt-2"]);
    });

    it("resolveByName returns the match, throws NotFoundError otherwise", async () => {
      const client = makeClient();
      const found = await client.runtimes.resolveByName(
        "customer-agent",
        "proj-1",
      );
      expect(found.id).toBe(RUNTIME.id);
      await expect(
        client.runtimes.resolveByName("does-not-exist", "proj-1"),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("handle resolves a name lazily then runs; pin injects recipe_id", async () => {
      requests = [];
      const client = makeClient();
      const runner = await client.runtimes("customer-agent").run({
        identity: { user_id: "u-1" },
      });
      // First request resolves the name, second opens the runner.
      expect(
        requests.some(
          (r) =>
            r.path === "/v1/runtimes" &&
            r.query.get("name") === "customer-agent",
        ),
      ).toBe(true);
      const runReq = requests.find((r) => r.path.endsWith("/run"));
      expect(
        (runReq?.body as { identity?: { user_id?: string } })?.identity
          ?.user_id,
      ).toBe("u-1");
      expect(runner.session_id).toBe("sess-1");

      requests = [];
      await client.runtimes(RUNTIME.id).pin(RECIPE).run();
      const pinned = requests.find((r) => r.path.endsWith("/run"));
      expect((pinned?.body as { recipe_id?: string })?.recipe_id).toBe(
        RECIPE.id,
      );
    });

    it("handle.activate hits the activate route", async () => {
      requests = [];
      const client = makeClient();
      const rt = await client
        .runtimes(RUNTIME.id)
        .activate({ projectId: "proj-1" });
      expect(rt.is_active).toBe(true);
      expect(requests.some((r) => r.path.endsWith("/activate"))).toBe(true);
    });
  });

  describe("service account auth", () => {
    it("mints a token via client_credentials (form-encoded)", async () => {
      requests = [];
      const tok = await serviceAccountToken({
        clientId: "intro_app_test",
        clientSecret: "intro_sk_test",
        projectId: "proj-1",
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

    it("maps bad credentials to a typed ValidationError", async () => {
      await expect(
        serviceAccountToken({
          clientId: "intro_app_test",
          clientSecret: "wrong",
          projectId: "proj-1",
          baseApiUrl: baseUrl,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("fromServiceAccount mints then resolves a runtime by name", async () => {
      requests = [];
      const client = await IntrospectionClient.fromServiceAccount({
        clientId: "intro_app_test",
        clientSecret: "intro_sk_test",
        projectId: "proj-1",
        baseApiUrl: baseUrl,
      });
      const runner = await client.runtimes(RUNTIME.name).run({
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
    it("CRUD + lifecycle + run", async () => {
      const client = makeClient();
      expect(
        await collect(client.experiments.list({ project_id: "proj-1" })),
      ).toHaveLength(1);
      expect(
        (await client.experiments.create({ name: "exp-a" } as never)).id,
      ).toBe(EXPERIMENT.id);
      expect((await client.experiments.get(EXPERIMENT.id)).id).toBe(
        EXPERIMENT.id,
      );
      expect(
        (
          await client.experiments.update(EXPERIMENT.id, {
            name: "exp-renamed",
          } as never)
        ).name,
      ).toBe("exp-renamed");
      await expect(
        client.experiments.delete(EXPERIMENT.id),
      ).resolves.toBeUndefined();

      const handle = client.experiments(EXPERIMENT.id);
      expect((await handle.start()).status).toBe("running");
      expect((await handle.end({ reason: "done" } as never)).status).toBe(
        "completed",
      );
      expect((await handle.cancel()).status).toBe("cancelled");
      const runner = await handle.run({ identity: { user_id: "u-2" } });
      expect(runner.session_id).toBe("sess-1");
    });

    it("list paginates", async () => {
      const client = makeClient();
      const seen = [];
      for await (const e of client.experiments.list({
        project_id: "proj-1",
      }))
        seen.push(e.id);
      expect(seen).toEqual([EXPERIMENT.id]);
    });
  });

  describe("recipes", () => {
    it("CRUD + list", async () => {
      const client = makeClient();
      expect(
        await collect(client.recipes.list({ project_id: "proj-1" })),
      ).toHaveLength(1);
      expect(
        (await client.recipes.create({ git_ref: "main" } as never)).id,
      ).toBe(RECIPE.id);
      expect((await client.recipes.get(RECIPE.id)).id).toBe(RECIPE.id);
      expect(
        (
          await client.recipes.update(RECIPE.id, {
            git_ref: "release",
          } as never)
        ).git_ref,
      ).toBe("release");
      await expect(client.recipes.delete(RECIPE.id)).resolves.toBeUndefined();
      const seen = [];
      for await (const r of client.recipes.list({ project_id: "proj-1" }))
        seen.push(r.id);
      expect(seen).toEqual([RECIPE.id]);
    });
  });

  describe("runner (data-plane handle)", () => {
    it("exposes accessors, runs DP calls, refresh re-mints, close guards", async () => {
      const client = makeClient();
      const runner = await client.runtimes(RUNTIME.id).run();

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
