/**
 * `IssuesApi` over `/v1/issues` (Data Plane): list filters and paging,
 * create, get, both PATCH shapes, delete, and the `Idempotency-Key` header.
 *
 * A fake `fetch` (or a mocked `request`) stands in for the Data Plane, so no
 * network boundary is crossed (AGENTS.md §6 case 1).
 */
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  ConflictError,
  HttpClient,
  IntrospectionClient,
  IssuesApi,
} from "@introspection-sdk/introspection-node";
import type {
  Issue,
  IssueMutation,
  IssuePatch,
  IssueUpdateParams,
} from "@introspection-sdk/introspection-node";
import { IntrospectionApiClient } from "@introspection-sdk/introspection-browser/api";

const ISSUE_ID = "0199a1b2-0000-7000-8000-000000000101";
const TASK_ID = "0199a1b2-0000-7000-8000-0000000000ee";
const MEMBER_ID = "0199a1b2-0000-7000-8000-0000000000cc";
const REQUEST_ID = "0199a1b2-0000-7000-8000-000000000201";
const EVENT_ID = "0199a1b2-0000-7000-8000-000000000301";
const FILE_ID = "0199a1b2-0000-7000-8000-000000000401";

const ISSUE: Issue = {
  id: ISSUE_ID,
  org_id: "0199a1b2-0000-7000-8000-0000000000aa",
  project_id: "0199a1b2-0000-7000-8000-0000000000bb",
  title: "Checkout times out for EU customers",
  description: "Three conversations hit a 30s timeout on /checkout.",
  priority: "high",
  status: "waiting",
  revision: 3,
  display_index: 42,
  task_id: TASK_ID,
  task_status: "idle",
  member_id: null,
  tags: ["customer:acme"],
  metadata: { region: "eu", attempts: 3, paged: true, owner: null },
  files: [
    {
      file_id: FILE_ID,
      name: "trace.json",
      checksum: "sha256:abc",
      source_event_ids: [EVENT_ID],
    },
  ],
  links: [{ url: "https://github.com/acme/app/pull/7", title: "Fix timeout" }],
  events: [{ event_id: EVENT_ID }],
  spans: [
    {
      trace_id: "0123456789abcdef0123456789abcdef",
      span_id: "0123456789abcdef",
    },
  ],
  open_requests: [
    {
      id: REQUEST_ID,
      question: "Can we raise the gateway timeout?",
      assignee_id: MEMBER_ID,
      created_at: "2026-11-01T10:00:00Z",
    },
  ],
  closed_at: null,
  created_at: "2026-10-30T09:00:00Z",
  updated_at: "2026-11-01T10:00:00Z",
};

function page(records: Issue[], next: string | null = null) {
  return { records, count: records.length, total_count: null, next };
}

function mockHttp(result: unknown = ISSUE) {
  return {
    request: vi.fn().mockResolvedValue(result),
  } as unknown as HttpClient;
}

function calls(http: HttpClient) {
  return (http.request as ReturnType<typeof vi.fn>).mock.calls.map(
    (call) => call[0],
  );
}

interface Sent {
  method: string;
  url: URL;
  idempotencyKey: string | null;
  body: unknown;
}

/** An `IntrospectionClient` whose Data Plane answers from `respond`. */
function client(respond: (sent: Sent) => Response) {
  const sent: Sent[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    const call: Sent = {
      method: init?.method ?? "GET",
      url: new URL(String(input)),
      idempotencyKey: headers.get("idempotency-key"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    sent.push(call);
    return respond(call);
  });
  const sdk = new IntrospectionClient({
    token: "intro_test",
    advanced: {
      baseApiUrl: "https://cp.test",
      dpUrl: "https://dp.test",
      fetch: fetch as unknown as typeof globalThis.fetch,
    },
  });
  return { sdk, sent };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("IssuesApi", () => {
  it("list() sends no filters by default and reads the issue shape", async () => {
    const http = mockHttp(page([ISSUE]));
    const first = await new IssuesApi(http).list();

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/issues",
      query: { next: undefined },
    });
    const issue = first.records[0];
    expect(issue.revision).toBe(3);
    expect(issue.task_status).toBe("idle");
    expect(issue.member_id).toBeNull();
    expect(issue.metadata).toEqual({
      region: "eu",
      attempts: 3,
      paged: true,
      owner: null,
    });
    expect(issue.open_requests[0].assignee_id).toBe(MEMBER_ID);
    expect(issue.files[0].source_event_ids).toEqual([EVENT_ID]);
    expect(issue.spans[0].span_id).toBe("0123456789abcdef");
    expect(first.total_count).toBeNull();
  });

  it("create() POSTs only the fields that are set", async () => {
    const http = mockHttp();
    const created = await new IssuesApi(http).create({
      task_id: TASK_ID,
      title: "Checkout times out",
      description: "Three conversations hit a timeout.",
      priority: undefined,
      links: [],
      events: [{ event_id: EVENT_ID }],
    });

    expect(created.id).toBe(ISSUE_ID);
    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/issues",
      body: {
        task_id: TASK_ID,
        title: "Checkout times out",
        description: "Three conversations hit a timeout.",
        links: [],
        events: [{ event_id: EVENT_ID }],
      },
    });
  });

  it("get() reads one issue", async () => {
    const http = mockHttp();
    const issue = await new IssuesApi(http).get(ISSUE_ID);

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: `/v1/issues/${ISSUE_ID}`,
    });
    expect(issue.display_index).toBe(42);
  });

  it("update() sends a brief edit with omitted fields left out and [] kept", async () => {
    const http = mockHttp();
    await new IssuesApi(http).update(ISSUE_ID, {
      expected_revision: 3,
      status: "closed",
      title: undefined,
      links: [],
      tags: [],
      metadata: {},
    });

    expect(http.request).toHaveBeenCalledWith({
      method: "PATCH",
      path: `/v1/issues/${ISSUE_ID}`,
      body: {
        expected_revision: 3,
        status: "closed",
        links: [],
        tags: [],
        metadata: {},
      },
    });
    expect(calls(http)[0].body).not.toHaveProperty("files");
    expect(calls(http)[0].body).not.toHaveProperty("title");
  });

  it("update() creates a human request at expected_revision 0", async () => {
    const http = mockHttp();
    await new IssuesApi(http).update(ISSUE_ID, {
      request: {
        id: REQUEST_ID,
        expected_revision: 0,
        question: "Can we raise the gateway timeout?",
        assignee_id: MEMBER_ID,
        status: undefined,
      },
    });

    expect(calls(http)[0].body).toEqual({
      request: {
        id: REQUEST_ID,
        expected_revision: 0,
        question: "Can we raise the gateway timeout?",
        assignee_id: MEMBER_ID,
      },
    });
  });

  it("update() resolves a human request at its own revision", async () => {
    const http = mockHttp();
    await new IssuesApi(http).update(ISSUE_ID, {
      request: {
        id: REQUEST_ID,
        expected_revision: 2,
        status: "resolved",
        resolution: "Raised to 60s; the timeouts stopped.",
      },
    });

    expect(calls(http)[0].body).toEqual({
      request: {
        id: REQUEST_ID,
        expected_revision: 2,
        status: "resolved",
        resolution: "Raised to 60s; the timeouts stopped.",
      },
    });
  });

  it("delete() soft-deletes and expects an empty response", async () => {
    const http = mockHttp(undefined);
    await new IssuesApi(http).delete(ISSUE_ID);

    expect(http.request).toHaveBeenCalledWith({
      method: "DELETE",
      path: `/v1/issues/${ISSUE_ID}`,
      expect: "empty",
    });
  });

  it("every write passes an Idempotency-Key through as a header", async () => {
    const http = mockHttp();
    const issues = new IssuesApi(http);
    await issues.create(
      { task_id: TASK_ID, title: "t", description: "d" },
      { idempotencyKey: "create-1" },
    );
    await issues.update(
      ISSUE_ID,
      { expected_revision: 1, priority: "urgent" },
      { idempotencyKey: "update-1" },
    );
    await issues.delete(ISSUE_ID, { idempotencyKey: "delete-1" });

    expect(calls(http).map((call) => call.headers)).toEqual([
      { "Idempotency-Key": "create-1" },
      { "Idempotency-Key": "update-1" },
      { "Idempotency-Key": "delete-1" },
    ]);
  });

  it("percent-encodes the id", async () => {
    const http = mockHttp();
    await new IssuesApi(http).get("a/b");

    expect(calls(http)[0].path).toBe("/v1/issues/a%2Fb");
  });

  it("types the PATCH body as a brief edit or a request mutation", () => {
    expectTypeOf<IssueUpdateParams>().toMatchTypeOf<IssuePatch>();
    expectTypeOf<IssueMutation>().toMatchTypeOf<IssuePatch>();
    const edit: IssuePatch = { expected_revision: 1, title: "t" };
    const mutation: IssuePatch = {
      request: { id: REQUEST_ID, expected_revision: 0 },
    };
    // @ts-expect-error a brief edit needs the revision it was read at
    const unversioned: IssuePatch = { title: "t" };
    // @ts-expect-error a request rides on its own, not in a brief edit
    const mixed: IssuePatch = {
      expected_revision: 1,
      request: { id: REQUEST_ID, expected_revision: 0 },
    };
    expect([edit, mutation, unversioned, mixed]).toHaveLength(4);
  });
});

describe("client.issues", () => {
  it("repeats array filters, flattens metadata and keeps them on every page", async () => {
    const pages = [
      page([ISSUE], "cursor-2"),
      page([{ ...ISSUE, id: "issue-2" }]),
    ];
    const { sdk, sent } = client(() => json(pages.shift()));

    const ids: string[] = [];
    for await (const issue of sdk.issues.list({
      limit: 1,
      status: ["open", "waiting"],
      owner: ["project", "me"],
      assigned_to_me: true,
      has_open_requests: false,
      task_status: ["running", "awaiting_user"],
      exclude_task_status: ["completed", "cancelled"],
      display_index: 42,
      tag: "customer:acme",
      metadata: { region: "eu", tier: "gold" },
      include_total: true,
    })) {
      ids.push(issue.id);
    }

    expect(ids).toEqual([ISSUE_ID, "issue-2"]);
    expect(
      sent.map((s) => `${s.method} ${s.url.origin}${s.url.pathname}`),
    ).toEqual([
      "GET https://dp.test/v1/issues",
      "GET https://dp.test/v1/issues",
    ]);
    const query = sent[0].url.searchParams;
    expect(query.getAll("status")).toEqual(["open", "waiting"]);
    expect(query.getAll("owner")).toEqual(["project", "me"]);
    expect(query.getAll("task_status")).toEqual(["running", "awaiting_user"]);
    expect(query.getAll("exclude_task_status")).toEqual([
      "completed",
      "cancelled",
    ]);
    expect(query.getAll("metadata")).toEqual(["region:eu", "tier:gold"]);
    expect(query.get("assigned_to_me")).toBe("true");
    expect(query.get("has_open_requests")).toBe("false");
    expect(query.get("display_index")).toBe("42");
    expect(query.get("tag")).toBe("customer:acme");
    expect(query.has("search")).toBe(false);
    expect(query.get("include_total")).toBe("true");
    expect(query.get("limit")).toBe("1");
    expect(query.has("next")).toBe(false);
    expect(sent[1].url.searchParams.get("next")).toBe("cursor-2");
    expect(sent[1].url.searchParams.getAll("status")).toEqual([
      "open",
      "waiting",
    ]);
    await sdk.shutdown();
  });

  it("takes a single value for a repeatable filter and starts from a cursor", async () => {
    const { sdk, sent } = client(() => json(page([ISSUE])));

    await sdk.issues.list({ status: "open", next: "cursor-9" });

    expect([...sent[0].url.searchParams]).toEqual([
      ["status", "open"],
      ["next", "cursor-9"],
    ]);
    await sdk.shutdown();
  });

  it("sends the Idempotency-Key header only when one is set", async () => {
    const { sdk, sent } = client((s) =>
      s.method === "DELETE"
        ? new Response(null, { status: 204 })
        : json(ISSUE, s.method === "POST" ? 201 : 200),
    );

    const created = await sdk.issues.create(
      { task_id: TASK_ID, title: "t", description: "d" },
      { idempotencyKey: "key-1" },
    );
    await sdk.issues.update(ISSUE_ID, { expected_revision: 3, files: [] });
    await sdk.issues.delete(ISSUE_ID, { idempotencyKey: "key-2" });

    expect(created.id).toBe(ISSUE_ID);
    expect(sent.map((s) => [s.method, s.idempotencyKey])).toEqual([
      ["POST", "key-1"],
      ["PATCH", null],
      ["DELETE", "key-2"],
    ]);
    expect(sent[1].body).toEqual({ expected_revision: 3, files: [] });
    await sdk.shutdown();
  });

  it("surfaces a stale revision as a ConflictError", async () => {
    const { sdk } = client(() =>
      json({ detail: "Issue revision is stale" }, 409),
    );

    await expect(
      sdk.issues.update(ISSUE_ID, { expected_revision: 1, title: "t" }),
    ).rejects.toBeInstanceOf(ConflictError);
    await sdk.shutdown();
  });
});

describe("browser client.issues", () => {
  it("is bound to the Data Plane session", () => {
    const api = new IntrospectionApiClient({
      dpUrl: "https://dp.test",
      getToken: () => "token",
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
    });

    expect(api.issues.list).toBeTypeOf("function");
    expect(api.issues.update).toBeTypeOf("function");
  });
});
