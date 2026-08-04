/**
 * Browser session lifecycle — `IntrospectionApiClient` with `getSession`.
 *
 * No LLM call crosses a network boundary (the DP `fetch` is injected), so
 * per AGENTS.md §6 case 1 a fake fetch is the right tool rather than a
 * recording.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IntrospectionApiClient,
  identityKey,
  type BrowserSessionBootstrap,
} from "@introspection-sdk/introspection-browser/api";
import { IntrospectionAPIError, NotFoundError } from "@introspection-sdk/types";

const TASK_FIXTURE = {
  id: "task-1",
  org_id: "org-1",
  project_id: "proj-1",
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
  mode: "agent" as const,
  status: "running" as const,
  is_archived: false,
};

const RUN_FIXTURE = {
  id: "run-1",
  task_id: "task-1",
  status: "running" as const,
};

function makeBootstrap(
  overrides: Partial<{
    endpoint: string;
    token: string;
    expiresInMs: number;
    identity: BrowserSessionBootstrap["runtime_context"]["identity"];
  }> = {},
): BrowserSessionBootstrap {
  return {
    session_id: "sess-1",
    session_token: overrides.token ?? "bootstrap-token",
    deployment: { endpoint: overrides.endpoint ?? "https://dp-a.example.com" },
    expires_at: new Date(
      Date.now() + (overrides.expiresInMs ?? 3_600_000),
    ).toISOString(),
    runtime_context: {
      runtime_id: "11111111-1111-1111-1111-111111111111",
      identity: overrides.identity ?? {
        user_id: "u_42",
        anonymous_id: null,
        conversation_id: null,
      },
    },
  };
}

interface Call {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
}

/**
 * Scriptable fetch: routes `/v1/oauth/exchange` and task calls, recording
 * every request. `respond` can override per-URL behaviour.
 */
function scriptedFetch(
  respond?: (url: string, calls: Call[]) => Response | undefined,
) {
  const calls: Call[] = [];
  const jsonRes = (status: number, payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  const impl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init: init as Call["init"] });
    const custom = respond?.(url, calls);
    if (custom) return custom;
    if (url.endsWith("/v1/oauth/exchange")) return jsonRes(200, {});
    if (url.endsWith("/v1/tasks") && init.method === "POST")
      return jsonRes(201, { task: TASK_FIXTURE, run: RUN_FIXTURE });
    if (url.endsWith("/v1/tasks/task-1")) return jsonRes(200, TASK_FIXTURE);
    return jsonRes(200, {});
  });
  return { impl: impl as unknown as typeof fetch, calls, jsonRes };
}

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { document?: unknown }).document;
});

describe("identityKey", () => {
  it("derives user > anon > conv, first non-null", () => {
    expect(
      identityKey({ user_id: "u", anonymous_id: "a", conversation_id: "c" }),
    ).toBe("user:u");
    expect(
      identityKey({ user_id: null, anonymous_id: "a", conversation_id: "c" }),
    ).toBe("anon:a");
    expect(
      identityKey({ user_id: null, anonymous_id: null, conversation_id: "c" }),
    ).toBe("conv:c");
    expect(
      identityKey({ user_id: null, anonymous_id: null, conversation_id: null }),
    ).toBeNull();
  });
});

describe("IntrospectionApiClient with getSession", () => {
  it("connect() brokers a bootstrap and exchanges at its endpoint", async () => {
    const { impl, calls } = scriptedFetch();
    const getSession = vi.fn(async () => makeBootstrap());
    const client = new IntrospectionApiClient({ getSession, fetch: impl });

    await client.connect();

    expect(getSession).toHaveBeenCalledOnce();
    expect(calls[0].url).toBe("https://dp-a.example.com/v1/oauth/exchange");
    expect(calls[0].init.credentials).toBe("include");
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      token: "bootstrap-token",
    });
  });

  it("dedupes concurrent connects into one broker + exchange", async () => {
    const { impl, calls } = scriptedFetch();
    const getSession = vi.fn(async () => makeBootstrap());
    const client = new IntrospectionApiClient({ getSession, fetch: impl });

    await Promise.all([client.connect(), client.connect(), client.connect()]);

    expect(getSession).toHaveBeenCalledOnce();
    expect(calls.filter((c) => c.url.endsWith("/oauth/exchange"))).toHaveLength(
      1,
    );
  });

  it("connects on first use and pins X-Expected-Identity afterwards", async () => {
    const { impl, calls } = scriptedFetch();
    const client = new IntrospectionApiClient({
      getSession: async () => makeBootstrap(),
      fetch: impl,
    });

    // No explicit connect(): the first request brokers + exchanges first.
    const task = await client.tasks.get("task-1");

    expect(task).toEqual(TASK_FIXTURE);
    expect(calls[0].url).toBe("https://dp-a.example.com/v1/oauth/exchange");
    expect(calls[1].url).toBe("https://dp-a.example.com/v1/tasks/task-1");
    expect(calls[1].init.headers["X-Expected-Identity"]).toBe("user:u_42");
  });

  it("rebuilds the transport when a fresh bootstrap moves endpoints", async () => {
    const { impl, calls } = scriptedFetch();
    const bootstraps = [
      makeBootstrap({ endpoint: "https://dp-a.example.com" }),
      makeBootstrap({ endpoint: "https://dp-b.example.com" }),
    ];
    const getSession = vi.fn(async () => bootstraps.shift()!);
    const client = new IntrospectionApiClient({ getSession, fetch: impl });

    await client.connect();
    const tasksRef = client.tasks; // held across the endpoint change
    await client.tasks.get("task-1");
    await client.connect(); // re-broker lands on DP B
    await tasksRef.get("task-1");

    expect(calls.map((c) => c.url)).toEqual([
      "https://dp-a.example.com/v1/oauth/exchange",
      "https://dp-a.example.com/v1/tasks/task-1",
      "https://dp-b.example.com/v1/oauth/exchange",
      "https://dp-b.example.com/v1/tasks/task-1",
    ]);
  });

  it("re-brokers before a create when the bootstrap is expired", async () => {
    const { impl, calls } = scriptedFetch();
    let expiresInMs = -60_000; // already expired
    const getSession = vi.fn(async () => makeBootstrap({ expiresInMs }));
    const client = new IntrospectionApiClient({ getSession, fetch: impl });

    await client.connect();
    expect(getSession).toHaveBeenCalledTimes(1);

    expiresInMs = 3_600_000; // the re-brokered bootstrap is fresh
    await client.tasks.create({ prompt: "hi", agent_name: "a" });

    // Create found the session expired → one re-broker + exchange first.
    expect(getSession).toHaveBeenCalledTimes(2);
    const urls = calls.map((c) => c.url);
    expect(urls).toEqual([
      "https://dp-a.example.com/v1/oauth/exchange",
      "https://dp-a.example.com/v1/oauth/exchange",
      "https://dp-a.example.com/v1/tasks",
    ]);

    // A second create against the now-fresh session does NOT re-broker.
    await client.tasks.create({ prompt: "again", agent_name: "a" });
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it("recovers ONCE from an identity_binding_mismatch 401, reusing the Idempotency-Key", async () => {
    let taskPosts = 0;
    const { impl, calls, jsonRes } = scriptedFetch((url) => {
      if (url.endsWith("/v1/tasks")) {
        taskPosts += 1;
        if (taskPosts === 1)
          return jsonRes(401, {
            detail: "identity mismatch",
            code: "identity_binding_mismatch",
          });
        return undefined; // fall through to the 201
      }
      return undefined;
    });
    const getSession = vi.fn(async () => makeBootstrap());
    const client = new IntrospectionApiClient({ getSession, fetch: impl });

    await client.connect();
    const res = await client.tasks.create({ prompt: "hi", agent_name: "a" });

    expect(res.task).toEqual(TASK_FIXTURE);
    // connect-broker + recovery re-broker: exactly two.
    expect(getSession).toHaveBeenCalledTimes(2);
    const creates = calls.filter((c) => c.url.endsWith("/v1/tasks"));
    expect(creates).toHaveLength(2);
    const keys = creates.map((c) => c.init.headers["Idempotency-Key"]);
    expect(keys[0]).toBeTruthy();
    // The retry re-sends the SAME key so the server can de-duplicate.
    expect(keys[1]).toBe(keys[0]);
    // The exchange happened between the two attempts.
    expect(calls.map((c) => c.url)).toEqual([
      "https://dp-a.example.com/v1/oauth/exchange",
      "https://dp-a.example.com/v1/tasks",
      "https://dp-a.example.com/v1/oauth/exchange",
      "https://dp-a.example.com/v1/tasks",
    ]);
  });

  it("never loops: a persistent 401 surfaces after one recovery attempt", async () => {
    const { impl, calls, jsonRes } = scriptedFetch((url) =>
      url.endsWith("/v1/tasks/task-1")
        ? jsonRes(401, { detail: "expired", code: "identity_binding_mismatch" })
        : undefined,
    );
    const getSession = vi.fn(async () => makeBootstrap());
    const client = new IntrospectionApiClient({ getSession, fetch: impl });

    await client.connect();
    await expect(client.tasks.get("task-1")).rejects.toThrow(
      IntrospectionAPIError,
    );

    // request → 401 → one re-broker+exchange → one retry → surface. 4 calls
    // total (incl. the initial connect exchange), not an endless loop.
    expect(getSession).toHaveBeenCalledTimes(2);
    expect(
      calls.filter((c) => c.url.endsWith("/v1/tasks/task-1")),
    ).toHaveLength(2);
  });

  it("generates a fresh Idempotency-Key per create (tasks + runs)", async () => {
    const { impl, calls } = scriptedFetch((url) =>
      url.includes("/runs")
        ? new Response(JSON.stringify({ run: RUN_FIXTURE }), {
            status: 201,
            headers: { "content-type": "application/json" },
          })
        : undefined,
    );
    const client = new IntrospectionApiClient({
      getSession: async () => makeBootstrap(),
      fetch: impl,
    });

    await client.tasks.create({ prompt: "one", agent_name: "a" });
    await client.tasks.create({ prompt: "two", agent_name: "a" });
    await client.tasks.runs.create("task-1", { message: "again" });

    const keyed = calls.filter((c) => c.init.headers?.["Idempotency-Key"]);
    expect(keyed).toHaveLength(3);
    const keys = keyed.map((c) => c.init.headers["Idempotency-Key"]);
    expect(new Set(keys).size).toBe(3);
  });

  it("does not treat a 404 as a session signal", async () => {
    const { impl, calls, jsonRes } = scriptedFetch((url) =>
      url.endsWith("/v1/tasks/task-1")
        ? jsonRes(404, { detail: "Task not found", code: "not_found" })
        : undefined,
    );
    const getSession = vi.fn(async () => makeBootstrap());
    const client = new IntrospectionApiClient({ getSession, fetch: impl });

    await client.connect();
    await expect(client.tasks.get("task-1")).rejects.toThrow(NotFoundError);

    // No re-broker, no re-exchange, no retry.
    expect(getSession).toHaveBeenCalledOnce();
    expect(
      calls.filter((c) => c.url.endsWith("/v1/tasks/task-1")),
    ).toHaveLength(1);
  });

  it("marks the session for re-brokering when the tab wakes past expiry", async () => {
    vi.useFakeTimers();
    const listeners: Record<string, () => void> = {};
    const removed: string[] = [];
    (globalThis as { document?: unknown }).document = {
      visibilityState: "visible",
      addEventListener: (name: string, fn: () => void) => {
        listeners[name] = fn;
      },
      removeEventListener: (name: string) => {
        removed.push(name);
      },
    };

    const { impl } = scriptedFetch();
    const getSession = vi.fn(async () =>
      makeBootstrap({ expiresInMs: 60_000 }),
    );
    const client = new IntrospectionApiClient({ getSession, fetch: impl });
    expect(listeners.visibilitychange).toBeTypeOf("function");

    await client.connect();
    expect(getSession).toHaveBeenCalledTimes(1);

    // Wake while still fresh: no invalidation, create does not re-broker.
    listeners.visibilitychange();
    await client.tasks.create({ prompt: "hi", agent_name: "a" });
    expect(getSession).toHaveBeenCalledTimes(1);

    // Sleep past expiry, then wake: the next create re-brokers.
    vi.setSystemTime(Date.now() + 120_000);
    listeners.visibilitychange();
    await client.tasks.create({ prompt: "hi again", agent_name: "a" });
    expect(getSession).toHaveBeenCalledTimes(2);

    client.dispose();
    expect(removed).toEqual(["visibilitychange"]);
  });

  it("dispose() is safe in non-DOM environments", () => {
    const { impl } = scriptedFetch();
    const client = new IntrospectionApiClient({
      getSession: async () => makeBootstrap(),
      fetch: impl,
    });
    expect(() => client.dispose()).not.toThrow();
  });

  it("getSession supersedes dpUrl + getToken when both are provided", async () => {
    const { impl, calls } = scriptedFetch();
    const getToken = vi.fn(async () => "legacy-token");
    const client = new IntrospectionApiClient({
      dpUrl: "https://legacy.example.com",
      getToken,
      getSession: async () => makeBootstrap(),
      fetch: impl,
    });

    await client.connect();

    expect(getToken).not.toHaveBeenCalled();
    expect(calls[0].url).toBe("https://dp-a.example.com/v1/oauth/exchange");
  });

  it("requires getSession or getToken", () => {
    const { impl } = scriptedFetch();
    expect(
      () =>
        new IntrospectionApiClient({
          dpUrl: "https://dp.example.com",
          fetch: impl,
        }),
    ).toThrow(/getSession or getToken/);
  });
});
