/**
 * The Data Plane surface `IntrospectionClient` and `Runner` share
 * (`DataPlaneResources`): each namespace driven through both, plus the
 * issue, connection and runner-automation specifics.
 *
 * A fake `fetch` stands in for the Data Plane, so no network boundary is
 * crossed (AGENTS.md §6 case 1).
 */
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  AppConnectionsApi,
  IntrospectionClient,
  IssuesApi,
  Runner,
} from "@introspection-sdk/introspection-node";
import type {
  AppConnection,
  ConnectPage,
  DataPlaneResources,
  Issue,
} from "@introspection-sdk/introspection-node";
import { RunnerExpiredError } from "@introspection-sdk/types";

const CLIENT_DP = "https://dp-client.example.com";
const RUNNER_DP = "https://dp-runner.example.com";
const RUNTIME_ID = "0199a1b2-0000-7000-8000-000000000011";
const RUNTIME_GROUP_ID = "0199a1b2-0000-7000-8000-0000000000dd";
const AUTOMATION_ID = "0199a1b2-0000-7000-8000-000000000001";
const ISSUE_ID = "0199a1b2-0000-7000-8000-000000000002";
const TASK_ID = "0199a1b2-0000-7000-8000-0000000000ee";
const CONNECTION_ID = "0199a1b2-0000-7000-8000-000000000004";
const MEMBER_ID = "0199a1b2-0000-7000-8000-0000000000cc";

interface Sent {
  method: string;
  url: string;
  auth: string | null;
  idempotencyKey: string | null;
  body: unknown;
}

function fakeDataPlane(respond: (sent: Sent) => Response = () => json({})) {
  const sent: Sent[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const raw = init?.body;
    const call: Sent = {
      method: init?.method ?? "GET",
      url: String(input),
      auth: headers.get("authorization"),
      idempotencyKey: headers.get("idempotency-key"),
      body: typeof raw === "string" ? JSON.parse(raw) : undefined,
    };
    sent.push(call);
    return respond(call);
  }) as typeof globalThis.fetch;
  return { sent, fetch };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function openClient(fetch: typeof globalThis.fetch): IntrospectionClient {
  return new IntrospectionClient({
    token: "member-token",
    advanced: {
      baseApiUrl: "https://api.example.com",
      dpUrl: CLIENT_DP,
      fetch,
    },
  });
}

function openRunner(
  fetch: typeof globalThis.fetch,
  runtimeGroupId: string | null = RUNTIME_GROUP_ID,
): Runner {
  return new Runner(openClient(fetch), { kind: "runtime", id: RUNTIME_ID }, {
    session_id: "sess-1",
    deployment: { endpoint: RUNNER_DP, slug: "gcp01", region: "us-east-1" },
    session_token: "runner-jwt",
    expires_at: "2099-01-01T00:00:00Z",
    runtime_context: {
      runtime_id: RUNTIME_ID,
      runtime_group_id: runtimeGroupId,
      experiment_id: null,
      recipe_id: "0199a1b2-0000-7000-8000-0000000000ff",
      recipe: {
        repository_id: "repo-1",
        git_ref: "main",
        git_commit_sha: "abc123",
      },
      arm_label: null,
      identity: {},
    },
  } as unknown as ConstructorParameters<typeof Runner>[2]);
}

const ISSUE_FIXTURE: Issue = {
  id: ISSUE_ID,
  org_id: "0199a1b2-0000-7000-8000-0000000000aa",
  project_id: "0199a1b2-0000-7000-8000-0000000000bb",
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-02T10:00:00Z",
  title: "Checkout fails for EU cards",
  description: "Card payments from EU issuers return 502.",
  priority: "high",
  tags: ["customer:acme"],
  metadata: { region: "eu", attempts: 3, escalated: true, owner: null },
  files: [],
  links: [{ url: "https://status.example.com/incidents/1", title: null }],
  events: [],
  spans: [
    {
      trace_id: "0af7651916cd43dd8448eb211c80319c",
      span_id: "b7ad6b7169203331",
    },
  ],
  display_index: 42,
  status: "open",
  revision: 3,
  task_id: TASK_ID,
  task_status: "idle",
  member_id: null,
  closed_at: null,
  open_requests: [
    {
      id: "0199a1b2-0000-7000-8000-000000000003",
      question: "Approve the refund?",
      assignee_id: "0199a1b2-0000-7000-8000-0000000000cc",
      created_at: "2026-10-02T09:00:00Z",
    },
  ],
};

type NamespaceCall = [
  name: string,
  call: (dp: DataPlaneResources) => Promise<unknown>,
  method: string,
  path: string,
];

const NAMESPACES: NamespaceCall[] = [
  ["tasks", (dp) => dp.tasks.get(TASK_ID), "GET", `/v1/tasks/${TASK_ID}`],
  [
    "tasks.runs",
    (dp) => dp.tasks.runs.get(TASK_ID, "run-1"),
    "GET",
    `/v1/tasks/${TASK_ID}/runs/run-1`,
  ],
  ["files", (dp) => dp.files.get("file-1"), "GET", "/v1/files/file-1"],
  [
    "conversations",
    (dp) => dp.conversations.get("conv-1"),
    "GET",
    "/v1/conversations/conv-1",
  ],
  ["events", (dp) => dp.events.get("event-1"), "GET", "/v1/events/event-1"],
  [
    "metrics",
    (dp) =>
      dp.metrics.query(
        {} as Parameters<DataPlaneResources["metrics"]["query"]>[0],
      ),
    "POST",
    "/v1/metrics",
  ],
  ["shares", (dp) => dp.shares.get("share-1"), "GET", "/v1/shares/share-1"],
  [
    "automations",
    (dp) => dp.automations.get(AUTOMATION_ID),
    "GET",
    `/v1/automations/${AUTOMATION_ID}`,
  ],
  ["issues", (dp) => dp.issues.get(ISSUE_ID), "GET", `/v1/issues/${ISSUE_ID}`],
  [
    "connections",
    (dp) => dp.connections.get(CONNECTION_ID),
    "GET",
    `/v1/connections/${CONNECTION_ID}`,
  ],
];

describe("DataPlaneResources", () => {
  it("is implemented by both the client and the runner", () => {
    expectTypeOf<IntrospectionClient>().toMatchTypeOf<DataPlaneResources>();
    expectTypeOf<Runner>().toMatchTypeOf<DataPlaneResources>();
  });

  it.each(NAMESPACES)(
    "%s reaches the same route from the client and the runner",
    async (_name, call, method, path) => {
      const { sent, fetch } = fakeDataPlane();

      await call(openClient(fetch));
      await call(openRunner(fetch));

      expect(sent.map((s) => [s.method, s.url, s.auth])).toEqual([
        [method, `${CLIENT_DP}${path}`, "Bearer member-token"],
        [method, `${RUNNER_DP}${path}`, "Bearer runner-jwt"],
      ]);
    },
  );
});

describe("connections", () => {
  const CONNECTION: AppConnection = {
    id: CONNECTION_ID,
    member_id: MEMBER_ID,
    app: "gmail",
    account_name: "Work inbox",
    healthy: true,
    created_at: "2026-10-06T10:00:00Z",
  };
  const PAGE: ConnectPage = {
    authorize_url: "https://connect.example.com/c/abc",
    expires_in: 600,
    expires_at: "2026-10-06T10:10:00Z",
  };

  it("list() filters by member and app and pages with the filters", async () => {
    const pages = [
      { records: [CONNECTION], count: 1, next: "cursor-2" },
      { records: [], count: 0, next: null },
    ];
    const { sent, fetch } = fakeDataPlane(() => json(pages.shift()));
    const connections = openRunner(fetch).connections;

    expect(connections).toBeInstanceOf(AppConnectionsApi);
    const seen: AppConnection[] = [];
    for await (const connection of connections.list({
      member_id: MEMBER_ID,
      app: "gmail",
      limit: 5,
    })) {
      seen.push(connection);
    }

    expect(seen).toEqual([CONNECTION]);
    expect(sent.map((s) => [s.method, s.url, s.auth])).toEqual([
      [
        "GET",
        `${RUNNER_DP}/v1/connections?member_id=${MEMBER_ID}&app=gmail&limit=5`,
        "Bearer runner-jwt",
      ],
      [
        "GET",
        `${RUNNER_DP}/v1/connections?member_id=${MEMBER_ID}&app=gmail&limit=5&next=cursor-2`,
        "Bearer runner-jwt",
      ],
    ]);
  });

  it("list() with no filters reads the caller's own", async () => {
    const { sent, fetch } = fakeDataPlane(() =>
      json({ records: [CONNECTION], count: 1, next: null }),
    );

    const page = await openClient(fetch).connections.list();

    expect(page.records).toEqual([CONNECTION]);
    expect(sent[0].url).toBe(`${CLIENT_DP}/v1/connections`);
  });

  it("runner create() sends the app with the runner's runtime group", async () => {
    const { sent, fetch } = fakeDataPlane(() => json(PAGE, 201));

    const result = await openRunner(fetch).connections.create({ app: "gmail" });

    expect(result).toEqual(PAGE);
    expect(sent).toEqual([
      {
        method: "POST",
        url: `${RUNNER_DP}/v1/connections`,
        auth: "Bearer runner-jwt",
        idempotencyKey: null,
        body: { app: "gmail", runtime: RUNTIME_GROUP_ID },
      },
    ]);
  });

  it("runner create() lets an explicit runtime win", async () => {
    const { sent, fetch } = fakeDataPlane(() => json(PAGE));

    await openRunner(fetch).connections.create({
      app: "gmail",
      runtime: "support-agent",
    });

    expect(sent[0].body).toEqual({ app: "gmail", runtime: "support-agent" });
  });

  it("client create() takes the runtime explicitly", async () => {
    const { sent, fetch } = fakeDataPlane(() => json(PAGE));
    const client = openClient(fetch);

    await client.connections.create({ app: "gmail", runtime: "support-agent" });

    expect(sent[0]).toMatchObject({
      method: "POST",
      url: `${CLIENT_DP}/v1/connections`,
      body: { app: "gmail", runtime: "support-agent" },
    });
    expectTypeOf(client.connections.create)
      .parameter(0)
      .toEqualTypeOf<{ app: string; runtime: string }>();
  });

  it("create() without a runtime from either source fails before a request", async () => {
    const { sent, fetch } = fakeDataPlane();

    await expect(
      openRunner(fetch, null).connections.create({ app: "gmail" }),
    ).rejects.toThrow(/runtime_group_id/);
    expect(sent).toEqual([]);
  });

  it("get() and delete() address one connection by id", async () => {
    const { sent, fetch } = fakeDataPlane((call) =>
      call.method === "DELETE"
        ? new Response(null, { status: 204 })
        : json(CONNECTION),
    );
    const connections = openClient(fetch).connections;

    expect(await connections.get(CONNECTION_ID)).toEqual(CONNECTION);
    await expect(connections.delete(CONNECTION_ID)).resolves.toBeUndefined();
    expect(sent.map((s) => [s.method, s.url])).toEqual([
      ["GET", `${CLIENT_DP}/v1/connections/${CONNECTION_ID}`],
      ["DELETE", `${CLIENT_DP}/v1/connections/${CONNECTION_ID}`],
    ]);
  });
});

describe("issues", () => {
  it("list() encodes every filter and pages with them", async () => {
    const pages = [
      { records: [ISSUE_FIXTURE], count: 1, next: "cursor-2" },
      { records: [], count: 0, next: null },
    ];
    const { sent, fetch } = fakeDataPlane(() => json(pages.shift()));
    const issues = openClient(fetch).issues;

    expect(issues).toBeInstanceOf(IssuesApi);
    const seen: Issue[] = [];
    for await (const issue of issues.list({
      limit: 10,
      status: ["open", "waiting"],
      owner: ["me"],
      assigned_to_me: true,
      has_open_requests: false,
      task_status: ["idle"],
      exclude_task_status: ["failed", "cancelled"],
      display_index: 42,
      tag: "customer:acme",
      metadata: { region: "eu", tier: "gold" },
      search: "checkout",
      include_total: true,
    })) {
      seen.push(issue);
    }

    expect(seen).toEqual([ISSUE_FIXTURE]);
    const first = new URL(sent[0].url);
    expect(first.pathname).toBe("/v1/issues");
    expect([...first.searchParams].sort()).toEqual(
      [
        ["limit", "10"],
        ["status", "open"],
        ["status", "waiting"],
        ["owner", "me"],
        ["assigned_to_me", "true"],
        ["has_open_requests", "false"],
        ["task_status", "idle"],
        ["exclude_task_status", "failed"],
        ["exclude_task_status", "cancelled"],
        ["display_index", "42"],
        ["tag", "customer:acme"],
        ["search", "checkout"],
        ["include_total", "true"],
        ["metadata", "region:eu"],
        ["metadata", "tier:gold"],
      ].sort(),
    );
    const second = new URL(sent[1].url);
    expect(second.searchParams.get("next")).toBe("cursor-2");
    expect(second.searchParams.getAll("status")).toEqual(["open", "waiting"]);
  });

  it("create() posts the set fields with an idempotency key", async () => {
    const { sent, fetch } = fakeDataPlane(() => json(ISSUE_FIXTURE, 201));

    const issue = await openRunner(fetch).issues.create(
      {
        title: "Checkout fails for EU cards",
        description: "Card payments from EU issuers return 502.",
        task_id: TASK_ID,
        priority: "high",
        tags: ["customer:acme"],
        metadata: { region: "eu" },
      },
      { idempotencyKey: "create-1" },
    );

    expect(issue).toEqual(ISSUE_FIXTURE);
    expect(sent[0]).toEqual({
      method: "POST",
      url: `${RUNNER_DP}/v1/issues`,
      auth: "Bearer runner-jwt",
      idempotencyKey: "create-1",
      body: {
        title: "Checkout fails for EU cards",
        description: "Card payments from EU issuers return 502.",
        task_id: TASK_ID,
        priority: "high",
        tags: ["customer:acme"],
        metadata: { region: "eu" },
      },
    });
  });

  it("update() sends only the set brief fields, or a request change", async () => {
    const { sent, fetch } = fakeDataPlane(() => json(ISSUE_FIXTURE));
    const issues = openRunner(fetch).issues;

    await issues.update(ISSUE_ID, {
      expected_revision: 3,
      status: "closed",
      title: undefined,
    });
    await issues.update(ISSUE_ID, {
      request: {
        id: "0199a1b2-0000-7000-8000-000000000003",
        expected_revision: 1,
        status: "resolved",
        resolution: "Refund approved per policy",
      },
    });

    expect(sent.map((s) => [s.method, s.url, s.idempotencyKey])).toEqual([
      ["PATCH", `${RUNNER_DP}/v1/issues/${ISSUE_ID}`, null],
      ["PATCH", `${RUNNER_DP}/v1/issues/${ISSUE_ID}`, null],
    ]);
    expect(sent[0].body).toEqual({ expected_revision: 3, status: "closed" });
    expect(sent[1].body).toEqual({
      request: {
        id: "0199a1b2-0000-7000-8000-000000000003",
        expected_revision: 1,
        status: "resolved",
        resolution: "Refund approved per policy",
      },
    });
  });

  it("delete() soft-deletes with an idempotency key", async () => {
    const { sent, fetch } = fakeDataPlane(
      () => new Response(null, { status: 204 }),
    );

    await expect(
      openClient(fetch).issues.delete(ISSUE_ID, { idempotencyKey: "del-1" }),
    ).resolves.toBeUndefined();
    expect(sent.map((s) => [s.method, s.url, s.idempotencyKey])).toEqual([
      ["DELETE", `${CLIENT_DP}/v1/issues/${ISSUE_ID}`, "del-1"],
    ]);
  });
});

describe("runner-bound namespaces after close()", () => {
  it("fail without a request", async () => {
    const { sent, fetch } = fakeDataPlane();
    const runner = openRunner(fetch);
    await runner.close();

    await expect(runner.issues.get(ISSUE_ID)).rejects.toBeInstanceOf(
      RunnerExpiredError,
    );
    await expect(runner.automations.get(AUTOMATION_ID)).rejects.toBeInstanceOf(
      RunnerExpiredError,
    );
    await expect(runner.connections.list()).rejects.toBeInstanceOf(
      RunnerExpiredError,
    );
    expect(sent).toEqual([]);
  });
});

describe("runner.automations", () => {
  it("lists, creates, triggers and deletes on the runner's token", async () => {
    const { sent, fetch } = fakeDataPlane((call) => {
      if (call.method === "GET") {
        return json({ records: [], count: 0, total_count: 0, next: null });
      }
      if (call.method === "DELETE") return new Response(null, { status: 204 });
      if (call.url.endsWith("/trigger")) {
        return json({ status: "accepted", task_id: "task-1" }, 202);
      }
      return json({ id: AUTOMATION_ID });
    });
    const runner = openRunner(fetch);

    await runner.automations.list({ enabled: true });
    await runner.automations.create({
      name: "Friday check-in",
      trigger_type: "manual",
      prompt: "How did the week go?",
      runtime_group_id: RUNTIME_GROUP_ID,
    });
    await runner.automations.trigger(AUTOMATION_ID);
    await runner.automations.delete(AUTOMATION_ID);

    expect(sent.map((s) => [s.method, s.url, s.auth])).toEqual([
      ["GET", `${RUNNER_DP}/v1/automations?enabled=true`, "Bearer runner-jwt"],
      ["POST", `${RUNNER_DP}/v1/automations`, "Bearer runner-jwt"],
      [
        "POST",
        `${RUNNER_DP}/v1/automations/${AUTOMATION_ID}/trigger`,
        "Bearer runner-jwt",
      ],
      [
        "DELETE",
        `${RUNNER_DP}/v1/automations/${AUTOMATION_ID}`,
        "Bearer runner-jwt",
      ],
    ]);
    expect(sent[1].body).toEqual({
      name: "Friday check-in",
      trigger_type: "manual",
      prompt: "How did the week go?",
      runtime_group_id: RUNTIME_GROUP_ID,
    });
  });
});
