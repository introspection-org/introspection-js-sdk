import { describe, expect, it, vi } from "vitest";
import {
  BrowserHttpClient,
  EventType,
  IntrospectionApiClient,
  RunHandle,
  TasksClient,
  TaskRunsClient,
} from "@introspection-sdk/introspection-browser/api";
import { IntrospectionAPIError } from "@introspection-sdk/types";

// Browser API client unit tests. No LLM call crosses a network boundary
// (the DP `fetch` is injected), so per AGENTS.md §6 case 1 a fake fetch
// is the right tool rather than a recording.

function mockHttp(overrides: Record<string, unknown> = {}) {
  return {
    request: vi.fn().mockResolvedValue(overrides.requestResult ?? {}),
    stream: vi.fn().mockResolvedValue(overrides.streamResult ?? new Response()),
  } as unknown as BrowserHttpClient;
}

function mockFetch(response: Partial<Response> & { ok: boolean }) {
  const headers = new Headers(
    (response.headers as HeadersInit) ?? { "content-type": "application/json" },
  );
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    headers,
    json: response.json ?? (() => Promise.resolve({})),
    text: response.text ?? (() => Promise.resolve("")),
    arrayBuffer:
      response.arrayBuffer ?? (() => Promise.resolve(new ArrayBuffer(0))),
    body: response.body ?? null,
  });
}

const TASK_FIXTURE = {
  id: "task-1",
  org_id: "org-1",
  project_id: "proj-1",
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
  kind: "agent" as const,
  status: "running" as const,
  is_archived: false,
};

const RUN_FIXTURE = {
  id: "run-1",
  task_id: "task-1",
  status: "running" as const,
};

describe("BrowserHttpClient", () => {
  it("sends cookies and omits the Authorization header", async () => {
    const fetchImpl = mockFetch({ ok: true, json: () => Promise.resolve({}) });
    const client = new BrowserHttpClient({
      apiUrl: "https://dp.example.com",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await client.request({ method: "GET", path: "/v1/tasks" });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://dp.example.com/v1/tasks");
    expect(init.credentials).toBe("include");
    expect(init.headers.Authorization).toBeUndefined();
  });

  it("sends JSON body with content-type for writes", async () => {
    const fetchImpl = mockFetch({
      ok: true,
      json: () => Promise.resolve({ task: TASK_FIXTURE, run: RUN_FIXTURE }),
    });
    const client = new BrowserHttpClient({
      apiUrl: "https://dp.example.com",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await client.request({
      method: "POST",
      path: "/v1/tasks",
      body: { prompt: "hi" },
    });

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ prompt: "hi" }));
  });

  it("merges additionalHeaders into requests", async () => {
    const fetchImpl = mockFetch({ ok: true, json: () => Promise.resolve({}) });
    const client = new BrowserHttpClient({
      apiUrl: "https://dp.example.com",
      additionalHeaders: { "X-Demo": "1" },
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await client.request({ method: "GET", path: "/v1/x" });

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers["X-Demo"]).toBe("1");
  });

  it("maps a non-ok response to IntrospectionAPIError", async () => {
    const fetchImpl = mockFetch({
      ok: false,
      status: 404,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ detail: "Task not found" }),
    });
    const client = new BrowserHttpClient({
      apiUrl: "https://dp.example.com",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.request({ method: "GET", path: "/v1/tasks/missing" }),
    ).rejects.toThrow(IntrospectionAPIError);
  });

  it("refreshes the session once on 401 then retries", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ detail: "expired" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ ok: true }),
      });
    const onUnauthorized = vi.fn().mockResolvedValue(true);
    const client = new BrowserHttpClient({
      apiUrl: "https://dp.example.com",
      fetch: fetchImpl as unknown as typeof fetch,
      onUnauthorized,
    });
    const result = await client.request<{ ok: boolean }>({
      method: "GET",
      path: "/v1/tasks",
    });

    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it("surfaces the 401 when the refresh fails", async () => {
    const fetchImpl = mockFetch({
      ok: false,
      status: 401,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ detail: "expired" }),
    });
    const client = new BrowserHttpClient({
      apiUrl: "https://dp.example.com",
      fetch: fetchImpl as unknown as typeof fetch,
      onUnauthorized: vi.fn().mockResolvedValue(false),
    });
    await expect(
      client.request({ method: "GET", path: "/v1/tasks" }),
    ).rejects.toThrow(IntrospectionAPIError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stream() requests an event-stream with cookies", async () => {
    const fetchImpl = mockFetch({ ok: true, body: new ReadableStream() });
    const client = new BrowserHttpClient({
      apiUrl: "https://dp.example.com",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await client.stream({ path: "/v1/tasks/t1/runs/r1/stream" });

    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Accept).toBe("text/event-stream");
    expect(init.credentials).toBe("include");
  });
});

describe("TasksClient", () => {
  it("create() posts the body to /v1/tasks", async () => {
    const http = mockHttp({
      requestResult: { task: TASK_FIXTURE, run: RUN_FIXTURE },
    });
    const tasks = new TasksClient(http);
    await tasks.create({ prompt: "hello", agent_name: "support-agent" });

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/tasks",
      body: { prompt: "hello", agent_name: "support-agent" },
    });
  });

  it("folds identity into metadata.identity on create", async () => {
    const http = mockHttp({
      requestResult: { task: TASK_FIXTURE, run: RUN_FIXTURE },
    });
    const tasks = new TasksClient(http);
    await tasks.create({
      prompt: "hello",
      runtime_id: "rt-1",
      metadata: { source: "web" },
      identity: { user_id: "u_42" },
    });

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/tasks",
      body: {
        prompt: "hello",
        runtime_id: "rt-1",
        metadata: { source: "web", identity: { user_id: "u_42" } },
      },
    });
  });

  it("start() creates a task and returns a RunHandle", async () => {
    const http = mockHttp({
      requestResult: { task: TASK_FIXTURE, run: RUN_FIXTURE },
    });
    const tasks = new TasksClient(http);
    const handle = await tasks.start({ prompt: "go", agent_name: "a" });

    expect(handle).toBeInstanceOf(RunHandle);
    expect(handle.task).toEqual(TASK_FIXTURE);
    expect(handle.run).toEqual(RUN_FIXTURE);
  });

  it("list() requests the first page of /v1/tasks", async () => {
    const http = mockHttp({
      requestResult: {
        records: [TASK_FIXTURE],
        count: 1,
        total_count: 1,
        next: null,
      },
    });
    const tasks = new TasksClient(http);
    const page = await tasks.list({ limit: 10, tag: "customer:acme" });

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/tasks",
      query: { limit: 10, tag: "customer:acme" },
    });
    expect(page.records).toHaveLength(1);
  });

  it("get() reads a single task", async () => {
    const http = mockHttp({ requestResult: TASK_FIXTURE });
    const tasks = new TasksClient(http);
    await tasks.get("task-1");

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/tasks/task-1",
    });
  });

  it("update() patches a task", async () => {
    const http = mockHttp({ requestResult: TASK_FIXTURE });
    const tasks = new TasksClient(http);
    await tasks.update("task-1", { title: "Renamed" });

    expect(http.request).toHaveBeenCalledWith({
      method: "PATCH",
      path: "/v1/tasks/task-1",
      body: { title: "Renamed" },
    });
  });

  it("delete()/archive()/unarchive() hit their routes", async () => {
    const http = mockHttp();
    const tasks = new TasksClient(http);
    await tasks.delete("task-1");
    await tasks.archive("task-1");
    await tasks.unarchive("task-1");

    expect(http.request).toHaveBeenNthCalledWith(1, {
      method: "DELETE",
      path: "/v1/tasks/task-1",
      expect: "empty",
    });
    expect(http.request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/v1/tasks/task-1/archive",
      expect: "empty",
    });
    expect(http.request).toHaveBeenNthCalledWith(3, {
      method: "POST",
      path: "/v1/tasks/task-1/unarchive",
      expect: "empty",
    });
  });
});

describe("RunHandle / TaskRunsClient", () => {
  it("text() collects AG-UI text deltas", async () => {
    const encoder = new TextEncoder();
    const streamPayload = [
      `event: ag_ui\ndata: ${JSON.stringify({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-1",
        delta: "Hello ",
      })}\n\n`,
      "event: heartbeat\ndata: {}\n\n",
      `event: ag_ui\ndata: ${JSON.stringify({
        type: EventType.TEXT_MESSAGE_CHUNK,
        messageId: "msg-1",
        delta: "world",
      })}\n\n`,
    ].join("");
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(streamPayload));
        controller.close();
      },
    });
    const http = mockHttp({ streamResult: new Response(stream) });
    const runs = new TaskRunsClient(http);
    const handle = new RunHandle(null, RUN_FIXTURE, runs);

    expect(await handle.text()).toBe("Hello world");
    expect(http.stream).toHaveBeenCalledWith({
      path: "/v1/tasks/task-1/runs/run-1/stream",
    });
  });

  it("cancel() posts to the run cancel route", async () => {
    const http = mockHttp({ requestResult: { id: "run-1" } });
    const runs = new TaskRunsClient(http);
    const handle = new RunHandle(TASK_FIXTURE, RUN_FIXTURE, runs);
    await handle.cancel();

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/tasks/task-1/runs/run-1/cancel",
    });
  });

  it("cancel() exposes the typed cancel modes", async () => {
    const http = mockHttp({ requestResult: { id: "run-1" } });
    const runs = new TaskRunsClient(http);
    const handle = new RunHandle(TASK_FIXTURE, RUN_FIXTURE, runs);
    await handle.cancel({ mode: "abort" });
    await handle.cancel({ mode: "drain", drain_within_seconds: 20 });

    expect(http.request).toHaveBeenNthCalledWith(1, {
      method: "POST",
      path: "/v1/tasks/task-1/runs/run-1/cancel",
      body: { mode: "abort" },
    });
    expect(http.request).toHaveBeenNthCalledWith(2, {
      method: "POST",
      path: "/v1/tasks/task-1/runs/run-1/cancel",
      body: { mode: "drain", drain_within_seconds: 20 },
    });
  });

  it("runs.create() returns a handle on the new run", async () => {
    const http = mockHttp({ requestResult: { run: RUN_FIXTURE } });
    const runs = new TaskRunsClient(http);
    const handle = await runs.create("task-1", { prompt: { text: "again" } });

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/tasks/task-1/runs",
      body: { prompt: { text: "again" } },
    });
    expect(handle).toBeInstanceOf(RunHandle);
    expect(handle.task).toBeNull();
  });
});

describe("IntrospectionApiClient", () => {
  it("connect() exchanges the broker token for a DP session cookie", async () => {
    const fetchImpl = mockFetch({ ok: true, json: () => Promise.resolve({}) });
    const getToken = vi.fn().mockResolvedValue("intro_access_token");
    const client = new IntrospectionApiClient({
      dpUrl: "https://dp.example.com/",
      getToken,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await client.connect();

    expect(getToken).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://dp.example.com/v1/oauth/exchange");
    expect(init.credentials).toBe("include");
    // The project is derived from the token's claims at the DP — the exchange
    // body carries only the token.
    expect(JSON.parse(init.body)).toEqual({
      token: "intro_access_token",
    });
  });

  it("connect() throws a typed error when the exchange is rejected", async () => {
    const fetchImpl = mockFetch({
      ok: false,
      status: 403,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ detail: "bad token" }),
    });
    const client = new IntrospectionApiClient({
      dpUrl: "https://dp.example.com",
      getToken: () => "t",
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await expect(client.connect()).rejects.toThrow(IntrospectionAPIError);
  });

  it("re-exchanges and retries a task request after a 401", async () => {
    // 1) task GET → 401, 2) re-exchange → 200, 3) task GET retry → 200
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ detail: "expired" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve(TASK_FIXTURE),
      });
    const getToken = vi.fn().mockResolvedValue("intro_access_token");
    const client = new IntrospectionApiClient({
      dpUrl: "https://dp.example.com",
      getToken,
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const task = await client.tasks.get("task-1");

    expect(task).toEqual(TASK_FIXTURE);
    // getToken called once for the re-exchange triggered by the 401.
    expect(getToken).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[1][0]).toBe(
      "https://dp.example.com/v1/oauth/exchange",
    );
  });

  it("re-exchanges once for concurrent 401s", async () => {
    // Three parallel calls hitting an expired cookie used to invoke the
    // app's getToken three times and race three exchanges; if the broker
    // single-uses its tokens the losers surfaced AuthenticationError even
    // though the session had just refreshed.
    let exchanges = 0;
    let sessionValid = false;
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === "https://dp.example.com/v1/oauth/exchange") {
        exchanges += 1;
        // Deliberately slow, so all three 401s land before the first
        // exchange resolves.
        await new Promise((resolve) => setTimeout(resolve, 5));
        sessionValid = true;
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve({}),
        };
      }
      if (!sessionValid) {
        return {
          ok: false,
          status: 401,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve({ detail: "expired" }),
          text: () => Promise.resolve("expired"),
        };
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve(TASK_FIXTURE),
      };
    });
    const getToken = vi.fn().mockResolvedValue("intro_access_token");
    const client = new IntrospectionApiClient({
      dpUrl: "https://dp.example.com",
      getToken,
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const tasks = await Promise.all([
      client.tasks.get("task-1"),
      client.tasks.get("task-2"),
      client.tasks.get("task-3"),
    ]);

    expect(tasks).toEqual([TASK_FIXTURE, TASK_FIXTURE, TASK_FIXTURE]);
    expect(exchanges).toBe(1);
    expect(getToken).toHaveBeenCalledOnce();
  });

  it("starts a task with a server-resolved runtime_id over the cookie session", async () => {
    const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
      if (url === "https://dp.example.com/v1/oauth/exchange") {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve({}),
        };
      }
      if (url === "https://dp.example.com/v1/tasks") {
        expect(init.method).toBe("POST");
        // Cookie session — no Authorization bearer in the browser.
        expect((init.headers as Record<string, string>).Authorization).toBe(
          undefined,
        );
        expect(init.credentials).toBe("include");
        expect(JSON.parse(init.body as string)).toEqual({
          prompt: "hello",
          runtime_id: "019ed295-5d76-7432-863b-f9327af50221",
        });
        return {
          ok: true,
          status: 201,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve({ task: TASK_FIXTURE, run: RUN_FIXTURE }),
        };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const client = new IntrospectionApiClient({
      dpUrl: "https://dp.example.com",
      getToken: () => "intro_access_token",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await client.connect();
    const run = await client.tasks.start({
      prompt: "hello",
      runtime_id: "019ed295-5d76-7432-863b-f9327af50221",
    });

    expect(run.task).toEqual(TASK_FIXTURE);
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "https://dp.example.com/v1/oauth/exchange",
    );
  });

  it("throws when constructed without a dpUrl", () => {
    expect(
      () =>
        new IntrospectionApiClient({
          dpUrl: "",
          getToken: () => "intro_access_token",
          fetch: mockFetch({ ok: true }) as unknown as typeof fetch,
        }),
    ).toThrow(/requires a dpUrl/);
  });
});

describe("environment-scoped sessions", () => {
  // The DP session cookie is named for its environment lane, so an app running
  // several lanes holds a live session for each in one browser. When more than
  // one is present the server cannot tell which a request means, so the
  // client names it.

  function exchangeReturning(environment?: string) {
    return mockFetch({
      ok: true,
      json: () => Promise.resolve(environment ? { environment } : {}),
    });
  }

  it("learns its lane from the exchange response", async () => {
    const fetchImpl = exchangeReturning("development");
    const client = new IntrospectionApiClient({
      dpUrl: "https://dp.example.com",
      getToken: () => "t",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    expect(client.environment).toBeUndefined();
    await client.connect();
    expect(client.environment).toBe("development");
  });

  it("names its lane on every subsequent request", async () => {
    const fetchImpl = vi.fn(async (url: string) => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      json: () =>
        Promise.resolve(
          url.endsWith("/v1/oauth/exchange")
            ? { environment: "staging" }
            : TASK_FIXTURE,
        ),
    }));
    const client = new IntrospectionApiClient({
      dpUrl: "https://dp.example.com",
      getToken: () => "t",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await client.connect();
    await client.tasks.get("task-1");

    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    const [, init] = calls[1]!;
    expect(
      (init.headers as Record<string, string>)["x-introspection-environment"],
    ).toBe("staging");
  });

  it("sends no lane header before connect() resolves one", async () => {
    const fetchImpl = mockFetch({
      ok: true,
      json: () => Promise.resolve(TASK_FIXTURE),
    });
    const client = new IntrospectionApiClient({
      dpUrl: "https://dp.example.com",
      getToken: () => "t",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await client.tasks.get("task-1");

    const [, init] = fetchImpl.mock.calls[0];
    expect(
      (init.headers as Record<string, string>)["x-introspection-environment"],
    ).toBeUndefined();
  });

  it("keeps two clients on separate lanes", async () => {
    const dev = new IntrospectionApiClient({
      dpUrl: "https://dp.example.com",
      getToken: () => "t",
      fetch: exchangeReturning("development") as unknown as typeof fetch,
    });
    const prod = new IntrospectionApiClient({
      dpUrl: "https://dp.example.com",
      getToken: () => "t",
      fetch: exchangeReturning("production") as unknown as typeof fetch,
    });

    await Promise.all([dev.connect(), prod.connect()]);

    // Per instance, never module scope — this is the whole feature.
    expect(dev.environment).toBe("development");
    expect(prod.environment).toBe("production");
  });

  it("sends a configured lane before the first exchange", async () => {
    const fetchImpl = mockFetch({
      ok: true,
      json: () => Promise.resolve(TASK_FIXTURE),
    });
    const client = new IntrospectionApiClient({
      dpUrl: "https://dp.example.com",
      getToken: () => "t",
      environment: "staging",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await client.tasks.get("task-1");

    const [, init] = fetchImpl.mock.calls[0];
    expect(
      (init.headers as Record<string, string>)["x-introspection-environment"],
    ).toBe("staging");
  });

  it("throws when the configured lane disagrees with the token", async () => {
    const client = new IntrospectionApiClient({
      dpUrl: "https://dp.example.com",
      getToken: () => "t",
      environment: "staging",
      fetch: exchangeReturning("production") as unknown as typeof fetch,
    });

    // Silently preferring one would send a header for a cookie we do not hold.
    await expect(client.connect()).rejects.toThrow(
      /configured for environment "staging".*token for "production"/,
    );
  });

  it("refreshes the lane when a 401 re-exchange switches it", async () => {
    // A broker that switched lanes between exchanges must not leave the client
    // naming a cookie it no longer holds.
    const fetchImpl = vi
      .fn()
      // connect()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ environment: "development" }),
      })
      // task GET -> 401
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ detail: "expired" }),
        text: () => Promise.resolve("expired"),
      })
      // re-exchange on a different lane
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ environment: "production" }),
      })
      // retry
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve(TASK_FIXTURE),
      });

    const client = new IntrospectionApiClient({
      dpUrl: "https://dp.example.com",
      getToken: () => "t",
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await client.connect();
    expect(client.environment).toBe("development");

    await client.tasks.get("task-1");

    expect(client.environment).toBe("production");
    const [, retryInit] = fetchImpl.mock.calls[3];
    expect(
      (retryInit.headers as Record<string, string>)[
        "x-introspection-environment"
      ],
    ).toBe("production");
  });

  it("tolerates an exchange response without a lane", async () => {
    // Migration window: a DP that predates the environment field.
    const client = new IntrospectionApiClient({
      dpUrl: "https://dp.example.com",
      getToken: () => "t",
      fetch: exchangeReturning() as unknown as typeof fetch,
    });

    await client.connect();

    expect(client.environment).toBeUndefined();
  });
});
