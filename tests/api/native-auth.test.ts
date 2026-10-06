/**
 * Native email-code sign-in (`AuthClient`) and the Data Plane surface it
 * authenticates, driven against a REAL in-process HTTP server.
 *
 * No mocks: a `node:http` server on loopback plays the Control Plane's
 * `/v1/oauth/*` routes and the Data Plane's `/v1/tasks` / `/v1/automations`,
 * and the SDK makes real round-trips to it with the global `fetch`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  AuthClient,
  DataPlaneClient,
  EMAIL_CODE_GRANT_TYPE,
  InMemorySessionStorage,
  IntrospectionClient,
  type AuthChangeEvent,
} from "@introspection-sdk/introspection-node";
import {
  AuthenticationError,
  RateLimitError,
  ValidationError,
} from "@introspection-sdk/types";

interface Captured {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string | undefined;
  contentType: string | undefined;
  body: string;
}

type Reply = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};
type Handler = (req: Captured) => Reply | Promise<Reply>;

let server: Server;
let baseUrl: string;
let requests: Captured[] = [];
let routes: Map<string, Handler>;

const AUTOMATION = {
  id: "0199a000-0000-7000-8000-000000000001",
  org_id: "org-1",
  project_id: "proj-1",
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  name: "Morning check-in",
  enabled: true,
  runtime_group_id: "0199a000-0000-7000-8000-0000000000aa",
  task_id: "0199a000-0000-7000-8000-0000000000bb",
  created_by_member_id: "member-1",
  can_manage: true,
  tags: [],
  trigger_type: "manual",
  prompt: "Anything new?",
  next_trigger_at: "2026-10-05T09:00:00+00:00",
  last_triggered_at: null,
  owner_role: "operator",
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });
}

function tokenResponse(
  access: string,
  extra: Record<string, unknown> = {},
): Reply {
  return {
    status: 200,
    body: {
      access_token: access,
      token_type: "Bearer",
      expires_in: 900,
      refresh_token: `refresh-for-${access}`,
      scope: "tasks:read tasks:write",
      session_id: "sess-1",
      org_id: "org-1",
      project_id: "proj-1",
      member_id: "member-1",
      ...extra,
    },
  };
}

function form(req: Captured): URLSearchParams {
  return new URLSearchParams(req.body);
}

function on(method: string, path: string, handler: Handler): void {
  routes.set(`${method} ${path}`, handler);
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const captured: Captured = {
      method: req.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      auth: req.headers.authorization,
      contentType: req.headers["content-type"],
      body: await readBody(req),
    };
    requests.push(captured);
    const handler = routes.get(`${captured.method} ${captured.path}`);
    const reply = handler
      ? await handler(captured)
      : { status: 404, body: { detail: "not found" } };
    res.writeHead(reply.status, {
      ...(reply.body === undefined
        ? {}
        : { "Content-Type": "application/json" }),
      ...reply.headers,
    });
    res.end(reply.body === undefined ? undefined : JSON.stringify(reply.body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  requests = [];
  routes = new Map();
});

function makeAuth(
  overrides: Partial<ConstructorParameters<typeof AuthClient>[0]> = {},
) {
  return new AuthClient({
    clientId: "intro_app_native",
    project: "my-project",
    baseApiUrl: baseUrl,
    ...overrides,
  });
}

/** Serve a successful verify that also names this server as the Data Plane. */
function serveVerify(access = "access-1"): void {
  on("POST", "/v1/oauth/token", (req) =>
    form(req).get("grant_type") === EMAIL_CODE_GRANT_TYPE
      ? tokenResponse(access, { dp_url: baseUrl })
      : { status: 400, body: { error: "unsupported_grant_type" } },
  );
}

describe("AuthClient — email-code sign-in", () => {
  it("sends the code request as JSON for the client and project", async () => {
    on("POST", "/v1/oauth/email/code", () => ({ status: 202 }));
    await makeAuth().signInWithOtp({ email: "ada@example.com" });

    const [sent] = requests;
    expect(sent.contentType).toBe("application/json");
    expect(JSON.parse(sent.body)).toEqual({
      client_id: "intro_app_native",
      email: "ada@example.com",
      project: "my-project",
    });
  });

  it("surfaces a send rate limit with its Retry-After", async () => {
    on("POST", "/v1/oauth/email/code", () => ({
      status: 429,
      body: { error: "slow_down", error_description: "Too many codes" },
      headers: { "Retry-After": "60" },
    }));
    const err = await makeAuth()
      .signInWithOtp({ email: "ada@example.com" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfter).toBe(60);
    expect((err as RateLimitError).code).toBe("slow_down");
    expect((err as RateLimitError).message).toBe("Too many codes");
  });

  it("verifies a letters-and-digits code with the email_code grant", async () => {
    serveVerify();
    const storage = new InMemorySessionStorage();
    const auth = makeAuth({ storage, now: () => 1_000_000 });
    const events: AuthChangeEvent[] = [];
    auth.onAuthStateChange((event) => events.push(event));

    const session = await auth.verifyOtp({
      email: "new@example.com",
      token: " K7Q2ZB ",
    });

    const sent = form(requests[0]);
    expect(Object.fromEntries(sent)).toEqual({
      grant_type: "urn:introspection:params:oauth:grant-type:email_code",
      client_id: "intro_app_native",
      email: "new@example.com",
      code: "K7Q2ZB",
      project: "my-project",
    });
    expect(session).toMatchObject({
      access_token: "access-1",
      refresh_token: "refresh-for-access-1",
      session_id: "sess-1",
      member_id: "member-1",
      dp_url: baseUrl,
      expires_at: 1_000_000 + 900_000,
    });
    expect(JSON.parse(storage.getItem("introspection.auth.session")!)).toEqual(
      session,
    );
    expect(events).toEqual(["INITIAL_SESSION", "SIGNED_IN"]);
  });

  it("maps a rejected code to a ValidationError coded invalid_grant", async () => {
    on("POST", "/v1/oauth/token", () => ({
      status: 400,
      body: {
        error: "invalid_grant",
        error_description: "The code is invalid or has expired",
      },
    }));
    const auth = makeAuth();
    const err = await auth
      .verifyOtp({ email: "ada@example.com", token: "000000" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).code).toBe("invalid_grant");
    expect((err as ValidationError).message).toBe(
      "The code is invalid or has expired",
    );
    expect(await auth.getSession()).toBeNull();
  });

  it("drops a sign-in response superseded by a sign-out", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    on("POST", "/v1/oauth/token", async () => {
      await held;
      return tokenResponse("late");
    });
    const auth = makeAuth();
    await auth.getSession();

    const pending = auth
      .verifyOtp({ email: "ada@example.com", token: "123456" })
      .catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await auth.signOut();
    release();

    const err = await pending;
    expect((err as DOMException).name).toBe("AbortError");
    expect(await auth.getSession()).toBeNull();
  });

  it("drops an older sign-in that resolves after a newer one", async () => {
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => (releaseFirst = resolve));
    let calls = 0;
    on("POST", "/v1/oauth/token", async () => {
      calls += 1;
      if (calls === 1) {
        await firstHeld;
        return tokenResponse("older");
      }
      return tokenResponse("newer");
    });
    const auth = makeAuth();
    await auth.getSession();

    const first = auth
      .verifyOtp({ email: "a@example.com", token: "111111" })
      .catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await auth.verifyOtp({ email: "b@example.com", token: "222222" });
    releaseFirst();

    expect(((await first) as DOMException).name).toBe("AbortError");
    expect((await auth.getSession())?.access_token).toBe("newer");
  });
});

describe("AuthClient — session lifecycle", () => {
  it("restores a stored session and reports it as INITIAL_SESSION", async () => {
    serveVerify();
    const storage = new InMemorySessionStorage();
    await makeAuth({ storage }).verifyOtp({
      email: "ada@example.com",
      token: "123456",
    });

    const restored = makeAuth({ storage });
    const initial = await new Promise<unknown>((resolve) =>
      restored.onAuthStateChange((event, session) => {
        if (event === "INITIAL_SESSION") resolve(session);
      }),
    );
    expect(initial).toMatchObject({ access_token: "access-1" });
  });

  it("refreshes ahead of expiry with the session keys and keeps dp_url", async () => {
    let clock = 0;
    on("POST", "/v1/oauth/token", (req) =>
      form(req).get("grant_type") === "refresh_token"
        ? tokenResponse("access-2", { refresh_token: "refresh-2" })
        : tokenResponse("access-1", { dp_url: baseUrl }),
    );
    const auth = makeAuth({ now: () => clock, leewaySeconds: 60 });
    const events: AuthChangeEvent[] = [];
    auth.onAuthStateChange((event) => events.push(event));
    await auth.verifyOtp({ email: "ada@example.com", token: "123456" });

    clock = 839_000; // 61 s before expiry: still fresh.
    expect((await auth.getSession())?.access_token).toBe("access-1");

    clock = 841_000; // inside the leeway: renewed first.
    const renewed = await auth.getSession();
    expect(Object.fromEntries(form(requests[1]))).toEqual({
      grant_type: "refresh_token",
      client_id: "intro_app_native",
      refresh_token: "refresh-for-access-1",
      session_id: "sess-1",
      org_id: "org-1",
    });
    expect(renewed).toMatchObject({
      access_token: "access-2",
      refresh_token: "refresh-2",
      dp_url: baseUrl,
    });
    expect(events).toEqual(["INITIAL_SESSION", "SIGNED_IN", "TOKEN_REFRESHED"]);
  });

  it("signs out when the refresh is rejected", async () => {
    on("POST", "/v1/oauth/token", (req) =>
      form(req).get("grant_type") === "refresh_token"
        ? {
            status: 400,
            body: {
              error: "invalid_grant",
              error_description: "Invalid or expired refresh_token",
            },
          }
        : tokenResponse("access-1"),
    );
    const storage = new InMemorySessionStorage();
    const auth = makeAuth({ storage });
    const events: AuthChangeEvent[] = [];
    auth.onAuthStateChange((event) => events.push(event));
    await auth.verifyOtp({ email: "ada@example.com", token: "123456" });

    await expect(auth.refreshSession()).rejects.toBeInstanceOf(
      AuthenticationError,
    );
    expect(await auth.getSession()).toBeNull();
    expect(storage.getItem("introspection.auth.session")).toBeNull();
    expect(events.at(-1)).toBe("SIGNED_OUT");
  });

  it("keeps the session through a refresh that fails in transit", async () => {
    on("POST", "/v1/oauth/token", (req) =>
      form(req).get("grant_type") === "refresh_token"
        ? {
            status: 503,
            body: { error: "temporarily_unavailable" },
          }
        : tokenResponse("access-1"),
    );
    const auth = makeAuth();
    await auth.verifyOtp({ email: "ada@example.com", token: "123456" });

    await expect(auth.refreshSession()).rejects.not.toBeInstanceOf(
      AuthenticationError,
    );
    expect((await auth.getSession())?.access_token).toBe("access-1");
  });

  it("revokes the platform session on sign-out", async () => {
    serveVerify();
    on("POST", "/v1/oauth/revoke", () => ({
      status: 200,
      body: { status: "revoked" },
    }));
    const auth = makeAuth();
    await auth.verifyOtp({ email: "ada@example.com", token: "123456" });
    await auth.signOut();

    const revoke = requests.find((r) => r.path === "/v1/oauth/revoke")!;
    expect(Object.fromEntries(form(revoke))).toEqual({
      client_id: "intro_app_native",
      session_id: "sess-1",
      org_id: "org-1",
    });
    expect(await auth.getSession()).toBeNull();
  });

  it("clears the local session even when revocation fails", async () => {
    serveVerify();
    on("POST", "/v1/oauth/revoke", () => ({
      status: 400,
      body: { detail: "Invalid client_id" },
    }));
    const auth = makeAuth();
    await auth.verifyOtp({ email: "ada@example.com", token: "123456" });

    await expect(auth.signOut()).rejects.toBeInstanceOf(ValidationError);
    expect(await auth.getSession()).toBeNull();
  });
});

describe("AuthClient.dataPlane()", () => {
  it("binds tasks to the session and refreshes once after a 401", async () => {
    on("POST", "/v1/oauth/token", (req) =>
      form(req).get("grant_type") === "refresh_token"
        ? tokenResponse("fresh")
        : tokenResponse("stale", { dp_url: baseUrl }),
    );
    on("POST", "/v1/tasks", (req) =>
      req.auth === "Bearer fresh"
        ? {
            status: 201,
            body: {
              task: { id: "task-1" },
              run: { id: "run-1", task_id: "task-1", status: "queued" },
            },
          }
        : { status: 401, body: { detail: "Token expired" } },
    );
    const auth = makeAuth();
    await auth.verifyOtp({ email: "ada@example.com", token: "123456" });
    const dp = await auth.dataPlane();

    const [a, b] = await Promise.all([
      dp.tasks.create({ prompt: "hi", runtime_id: "rt-1" }),
      dp.tasks.create({ prompt: "hi", runtime_id: "rt-1" }),
    ]);

    expect(a.run.id).toBe("run-1");
    expect(b.run.id).toBe("run-1");
    const refreshes = requests.filter(
      (r) =>
        r.path === "/v1/oauth/token" &&
        form(r).get("grant_type") === "refresh_token",
    );
    expect(refreshes).toHaveLength(1);
    const creates = requests.filter((r) => r.path === "/v1/tasks");
    expect(JSON.parse(creates.at(-1)!.body)).toEqual({
      prompt: "hi",
      runtime_id: "rt-1",
    });
  });

  it("refuses to build without a Data Plane URL", async () => {
    on("POST", "/v1/oauth/token", () => tokenResponse("access-1"));
    const auth = makeAuth();
    await expect(auth.dataPlane()).rejects.toThrow("Not signed in");
    await auth.verifyOtp({ email: "ada@example.com", token: "123456" });
    await expect(auth.dataPlane()).rejects.toThrow("no dp_url");
    expect((await auth.dataPlane({ dpUrl: baseUrl })).tasks).toBeDefined();
  });

  it("validates its options", () => {
    expect(() => makeAuth({ clientId: "" })).toThrow("clientId");
    expect(() => makeAuth({ project: "" })).toThrow("project");
    expect(() => new DataPlaneClient({ dpUrl: "" })).toThrow("dpUrl");
    expect(() => new DataPlaneClient({ dpUrl: baseUrl })).toThrow(
      "token or credentials",
    );
  });
});

describe("automations", () => {
  it("round-trips CRUD and the hand trigger on the Data Plane", async () => {
    on("GET", "/v1/automations", () => ({
      status: 200,
      body: { records: [AUTOMATION], count: 1, total_count: null, next: null },
    }));
    on("POST", "/v1/automations", () => ({ status: 201, body: AUTOMATION }));
    on("GET", `/v1/automations/${AUTOMATION.id}`, () => ({
      status: 200,
      body: AUTOMATION,
    }));
    on("PATCH", `/v1/automations/${AUTOMATION.id}`, (req) => ({
      status: 200,
      body: { ...AUTOMATION, ...JSON.parse(req.body) },
    }));
    on("POST", `/v1/automations/${AUTOMATION.id}/trigger`, () => ({
      status: 202,
      body: {
        status: "triggered",
        automation_id: AUTOMATION.id,
        task_id: AUTOMATION.task_id,
        reason: null,
      },
    }));
    on("DELETE", `/v1/automations/${AUTOMATION.id}`, () => ({ status: 204 }));

    const dp = new DataPlaneClient({ dpUrl: baseUrl, token: "dp-token" });

    const page = await dp.automations.list({
      kind: "observation_clustering",
      enabled: true,
      scheduled: false,
      limit: 10,
    });
    expect(page.records[0].can_manage).toBe(true);
    expect(Object.fromEntries(requests[0].query)).toEqual({
      kind: "observation_clustering",
      enabled: "true",
      scheduled: "false",
      limit: "10",
    });
    expect(requests[0].auth).toBe("Bearer dp-token");

    await dp.automations.create({
      name: "Morning check-in",
      trigger_type: "manual",
      prompt: "Anything new?",
      runtime_group_id: AUTOMATION.runtime_group_id,
      task_id: AUTOMATION.task_id,
      next_trigger_at: "2026-10-05T09:00:00+00:00",
    });
    expect(JSON.parse(requests[1].body)).toMatchObject({
      trigger_type: "manual",
      task_id: AUTOMATION.task_id,
      next_trigger_at: "2026-10-05T09:00:00+00:00",
    });

    expect((await dp.automations.get(AUTOMATION.id)).name).toBe(
      "Morning check-in",
    );
    const paused = await dp.automations.update(AUTOMATION.id, {
      enabled: false,
    });
    expect(paused.enabled).toBe(false);
    const fired = await dp.automations.trigger(AUTOMATION.id);
    expect(fired).toMatchObject({
      status: "triggered",
      task_id: AUTOMATION.task_id,
    });
    await expect(dp.automations.delete(AUTOMATION.id)).resolves.toBeUndefined();
  });

  it("hangs off IntrospectionClient's Data Plane client", async () => {
    on("GET", "/v1/automations", () => ({
      status: 200,
      body: { records: [], count: 0, total_count: null, next: null },
    }));
    const client = new IntrospectionClient({
      token: "api-key",
      advanced: { baseApiUrl: baseUrl, dpUrl: baseUrl },
    });
    expect((await client.automations.list()).records).toEqual([]);
  });

  it("filters automation firings on /v1/events", async () => {
    on("GET", "/v1/events", () => ({
      status: 200,
      body: {
        records: [
          {
            id: "evt-1",
            timestamp: "2026-10-05T09:00:01Z",
            event_name: "introspection.automation.triggered",
            payload: {
              automation_id: AUTOMATION.id,
              automation_name: AUTOMATION.name,
              trigger_type: "manual",
              slot: "2026-10-05T09:00:00+00:00",
              task_id: AUTOMATION.task_id,
              posted: true,
              member_id: "member-1",
            },
          },
        ],
        count: 1,
        total_count: null,
        next: null,
      },
    }));
    const dp = new DataPlaneClient({ dpUrl: baseUrl, token: "dp-token" });
    const page = await dp.events.list({
      event_name: "introspection.automation.triggered",
      automation_id: AUTOMATION.id,
      task_id: AUTOMATION.task_id,
    });
    expect(page.records[0].payload.posted).toBe(true);
    expect(requests[0].query.get("automation_id")).toBe(AUTOMATION.id);
    expect(requests[0].query.get("task_id")).toBe(AUTOMATION.task_id);
  });
});
