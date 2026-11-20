/**
 * `IssuesApi` over `/v1/issues` (Data Plane): list filters and paging,
 * create, get, update, delete, `include`, the people on an issue, comments,
 * and the `If-Match` precondition.
 *
 * A fake `fetch` (or a mocked `request`) stands in for the Data Plane, so no
 * network boundary is crossed (AGENTS.md §6 case 1).
 */
import { describe, expect, it, vi } from "vitest";
import {
  HttpClient,
  IntrospectionAPIError,
  IntrospectionClient,
  IssuesApi,
  isKnownIssueAttachment,
  issueEtag,
} from "@introspection-sdk/introspection-node";
import type {
  Issue,
  IssueAttachment,
  IssueComment,
  IssueUpdateParams,
} from "@introspection-sdk/introspection-node";
import {
  IntrospectionApiClient,
  isKnownIssueAttachment as browserIsKnownIssueAttachment,
  issueEtag as browserIssueEtag,
} from "@introspection-sdk/introspection-browser/api";

const ISSUE_ID = "0199a1b2-0000-7000-8000-000000000101";
const TASK_ID = "0199a1b2-0000-7000-8000-0000000000ee";
const MEMBER_ID = "0199a1b2-0000-7000-8000-0000000000cc";
const REVIEWER_ID = "0199a1b2-0000-7000-8000-0000000000dd";
const COMMENT_ID = "0199a1b2-0000-7000-8000-000000000201";
const EVENT_ID = "0199a1b2-0000-7000-8000-000000000301";
const FILE_ID = "0199a1b2-0000-7000-8000-000000000401";
const LINK_ATTACHMENT_ID = "0199a1b2-0000-7000-8000-000000000501";
const FILE_ATTACHMENT_ID = "0199a1b2-0000-7000-8000-000000000502";
const EVENT_ATTACHMENT_ID = "0199a1b2-0000-7000-8000-000000000503";
const SPAN_ATTACHMENT_ID = "0199a1b2-0000-7000-8000-000000000504";
const TRACE_ID = "0123456789abcdef0123456789abcdef";
const SPAN_ID = "0123456789abcdef";

const ATTACHMENTS: IssueAttachment[] = [
  {
    id: LINK_ATTACHMENT_ID,
    kind: "link",
    url: "https://github.com/acme/app/pull/7",
    title: "Fix timeout",
  },
  {
    id: FILE_ATTACHMENT_ID,
    kind: "file",
    file_id: FILE_ID,
    name: "trace.json",
    checksum: "sha256:abc",
    source_event_ids: [EVENT_ID],
  },
  { id: EVENT_ATTACHMENT_ID, kind: "event", event_id: EVENT_ID },
  {
    id: SPAN_ATTACHMENT_ID,
    kind: "span",
    trace_id: TRACE_ID,
    span_id: SPAN_ID,
  },
];

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
  display_key: "I-42",
  task_id: TASK_ID,
  task_status: "idle",
  member_id: null,
  tags: ["customer:acme"],
  metadata: { region: "eu", attempts: 3, paged: true, owner: null },
  created_by_member_id: MEMBER_ID,
  assignee_member_id: MEMBER_ID,
  reviewer_member_id: null,
  members: null,
  attachments: null,
  comments: null,
  closed_at: null,
  created_at: "2026-10-30T09:00:00Z",
  updated_at: "2026-11-01T10:00:00Z",
};

const COMMENT: IssueComment = {
  id: COMMENT_ID,
  issue_id: ISSUE_ID,
  comment: "Can we raise the gateway timeout?",
  member_id: MEMBER_ID,
  actor_member_id: null,
  actor_member_type: null,
  created_at: "2026-11-01T10:00:00Z",
};

/** The issue as a read with every include returns it. */
const FULL_ISSUE: Issue = {
  ...ISSUE,
  members: [
    { member_id: MEMBER_ID, relation: "creator" },
    { member_id: MEMBER_ID, relation: "assignee" },
    { member_id: REVIEWER_ID, relation: "follower" },
  ],
  attachments: ATTACHMENTS,
  comments: [
    COMMENT,
    {
      ...COMMENT,
      id: "0199a1b2-0000-7000-8000-000000000202",
      comment: "Raised to 60s.",
      actor_member_id: REVIEWER_ID,
      actor_member_type: "agent",
    },
  ],
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
  ifMatch: string | null;
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
      ifMatch: headers.get("if-match"),
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
      schema: "Paginated<Issue>",
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
    expect(issue.assignee_member_id).toBe(MEMBER_ID);
    expect(issue.reviewer_member_id).toBeNull();
    // A list the read did not include is null.
    expect(issue.members).toBeNull();
    expect(issue.attachments).toBeNull();
    expect(issue.comments).toBeNull();
    expect(first.total_count).toBeNull();
  });

  it("create() POSTs only the fields that are set", async () => {
    const http = mockHttp();
    const created = await new IssuesApi(http).create({
      task_id: TASK_ID,
      title: "Checkout times out",
      description: "Three conversations hit a timeout.",
      priority: undefined,
      tags: [],
    });

    expect(created.id).toBe(ISSUE_ID);
    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/issues",
      body: {
        task_id: TASK_ID,
        title: "Checkout times out",
        description: "Three conversations hit a timeout.",
        tags: [],
      },
      schema: "Issue",
    });
  });

  it("get() reads one issue", async () => {
    const http = mockHttp();
    const issue = await new IssuesApi(http).get(ISSUE_ID);

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: `/v1/issues/${ISSUE_ID}`,
      schema: "Issue",
    });
    expect(issue.display_index).toBe(42);
    expect(issue.display_key).toBe("I-42");
  });

  it("update() sends a brief edit with omitted fields left out and [] kept", async () => {
    const http = mockHttp();
    await new IssuesApi(http).update(ISSUE_ID, {
      status: "closed",
      title: undefined,
      tags: [],
      metadata: {},
    });

    expect(http.request).toHaveBeenCalledWith({
      method: "PATCH",
      path: `/v1/issues/${ISSUE_ID}`,
      body: {
        status: "closed",
        tags: [],
        metadata: {},
      },
      schema: "Issue",
    });
    expect(calls(http)[0].body).not.toHaveProperty("add_attachments");
    expect(calls(http)[0].body).not.toHaveProperty("title");
  });

  it("get() asks for each include and reads the lists it returns", async () => {
    const http = mockHttp(FULL_ISSUE);
    const issue = await new IssuesApi(http).get(ISSUE_ID, {
      include: ["members", "attachments", "comments"],
    });

    expect(calls(http)[0].query).toEqual({
      include: ["members", "attachments", "comments"],
    });
    expect(issue.members?.map((member) => member.relation)).toEqual([
      "creator",
      "assignee",
      "follower",
    ]);
    expect(issue.attachments).toEqual(ATTACHMENTS);
    expect(issue.comments).toHaveLength(2);
    expect(issue.comments?.[1]?.actor_member_type).toBe("agent");
  });

  it("get() reads attachments discriminated on kind, in order", async () => {
    const http = mockHttp(FULL_ISSUE);
    const issue = await new IssuesApi(http).get(ISSUE_ID, {
      include: ["attachments"],
    });

    const attachments = issue.attachments ?? [];
    expect(attachments.map((a) => [a.kind, a.id])).toEqual([
      ["link", LINK_ATTACHMENT_ID],
      ["file", FILE_ATTACHMENT_ID],
      ["event", EVENT_ATTACHMENT_ID],
      ["span", SPAN_ATTACHMENT_ID],
    ]);
    const described = attachments.map((a) => {
      if (!isKnownIssueAttachment(a)) return a.kind;
      switch (a.kind) {
        case "link":
          return a.url;
        case "file":
          return a.file_id;
        case "event":
          return a.event_id;
        case "span":
          return `${a.trace_id}/${a.span_id}`;
      }
    });
    expect(described).toEqual([
      "https://github.com/acme/app/pull/7",
      FILE_ID,
      EVENT_ID,
      `${TRACE_ID}/${SPAN_ID}`,
    ]);
  });

  it("keeps an attachment of a kind this SDK predates as the server sent it", async () => {
    const unknown = {
      id: LINK_ATTACHMENT_ID,
      kind: "commit",
      sha: "0123456789abcdef0123456789abcdef01234567",
    };
    const http = mockHttp({ ...ISSUE, attachments: [unknown] });
    const issue = await new IssuesApi(http).get(ISSUE_ID, {
      include: ["attachments"],
    });

    const [attachment] = issue.attachments ?? [];
    expect(attachment).toEqual(unknown);
    expect(isKnownIssueAttachment(attachment)).toBe(false);
    expect(attachment.id).toBe(LINK_ATTACHMENT_ID);
    expect(browserIsKnownIssueAttachment).toBe(isKnownIssueAttachment);
  });

  it("create() sends attachments tagged on kind", async () => {
    const http = mockHttp(FULL_ISSUE);
    await new IssuesApi(http).create({
      task_id: TASK_ID,
      title: "t",
      description: "d",
      attachments: [
        { kind: "link", url: "https://github.com/acme/app/pull/7" },
        { kind: "file", file_id: FILE_ID },
        { kind: "event", event_id: EVENT_ID },
        { kind: "span", trace_id: TRACE_ID, span_id: SPAN_ID },
      ],
    });

    expect(calls(http)[0].body).toEqual({
      task_id: TASK_ID,
      title: "t",
      description: "d",
      attachments: [
        { kind: "link", url: "https://github.com/acme/app/pull/7" },
        { kind: "file", file_id: FILE_ID },
        { kind: "event", event_id: EVENT_ID },
        { kind: "span", trace_id: TRACE_ID, span_id: SPAN_ID },
      ],
    });
  });

  it("update() adds and removes attachments without If-Match", async () => {
    const http = mockHttp(FULL_ISSUE);
    await new IssuesApi(http).update(
      ISSUE_ID,
      {
        add_attachments: [
          {
            kind: "link",
            url: "https://github.com/acme/app/pull/8",
            title: "Retry",
          },
        ],
        remove_attachments: [SPAN_ATTACHMENT_ID],
      },
      { include: ["attachments"] },
    );

    const [sent] = calls(http);
    expect(sent.body).toEqual({
      add_attachments: [
        {
          kind: "link",
          url: "https://github.com/acme/app/pull/8",
          title: "Retry",
        },
      ],
      remove_attachments: [SPAN_ATTACHMENT_ID],
    });
    expect(sent.headers).toBeUndefined();
    expect(sent.query).toEqual({ include: ["attachments"] });
  });

  it("types an attachment to create without an id or an unknown kind", () => {
    const withId: IssueUpdateParams = {
      add_attachments: [
        // @ts-expect-error the server assigns an attachment's id
        { id: LINK_ATTACHMENT_ID, kind: "link", url: "https://x.test" },
      ],
    };
    const unknownKind: IssueUpdateParams = {
      // @ts-expect-error only the known kinds can be created
      add_attachments: [{ kind: "commit", sha: "abc" }],
    };
    expect([withId, unknownKind]).toHaveLength(2);
  });

  it("create() and update() set the people and ask for includes", async () => {
    const http = mockHttp(FULL_ISSUE);
    const issues = new IssuesApi(http);
    await issues.create(
      {
        task_id: TASK_ID,
        title: "t",
        description: "d",
        assignee_member_id: MEMBER_ID,
        reviewer_member_id: REVIEWER_ID,
        follower_member_ids: [REVIEWER_ID],
      },
      { include: ["members"] },
    );
    await issues.update(
      ISSUE_ID,
      { assignee_member_id: REVIEWER_ID, follower_member_ids: [] },
      { include: ["members", "attachments"], ifMatch: '"1"' },
    );

    const [created, updated] = calls(http);
    expect(created.body).toMatchObject({
      assignee_member_id: MEMBER_ID,
      reviewer_member_id: REVIEWER_ID,
      follower_member_ids: [REVIEWER_ID],
    });
    expect(created.query).toEqual({ include: ["members"] });
    expect(updated.body).toEqual({
      assignee_member_id: REVIEWER_ID,
      follower_member_ids: [],
    });
    expect(updated.query).toEqual({ include: ["members", "attachments"] });
    expect(updated.headers).toEqual({ "If-Match": '"1"' });
  });

  it("update() sends an explicit null to clear a person and omits one left alone", async () => {
    const http = mockHttp();
    const issues = new IssuesApi(http);
    await issues.update(ISSUE_ID, { assignee_member_id: null });
    await issues.update(ISSUE_ID, {
      status: "waiting",
      assignee_member_id: undefined,
      reviewer_member_id: null,
    });

    const [cleared, mixed] = calls(http);
    expect(cleared.body).toEqual({ assignee_member_id: null });
    expect(mixed.body).toEqual({ status: "waiting", reviewer_member_id: null });
    expect(mixed.body).not.toHaveProperty("assignee_member_id");
  });

  it("comments.create() posts the comment and returns it", async () => {
    const http = mockHttp(COMMENT);
    const comment = await new IssuesApi(http).comments.create("a/b", {
      comment: "Can we raise the gateway timeout?",
    });

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/issues/a%2Fb/comments",
      body: { comment: "Can we raise the gateway timeout?" },
      schema: "IssueComment",
    });
    expect(comment.id).toBe(COMMENT_ID);
    expect(comment.member_id).toBe(MEMBER_ID);
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

  it("update() and delete() send If-Match only when ifMatch is set", async () => {
    const http = mockHttp();
    const issues = new IssuesApi(http);
    await issues.update(
      ISSUE_ID,
      { priority: "urgent" },
      { ifMatch: '"2026-11-04T01:00:00.123456Z"' },
    );
    await issues.update(ISSUE_ID, { priority: "low" });
    await issues.delete(ISSUE_ID, { ifMatch: '"2026-11-04T01:00:01.654321Z"' });

    expect(calls(http).map((call) => call.headers)).toEqual([
      { "If-Match": '"2026-11-04T01:00:00.123456Z"' },
      undefined,
      { "If-Match": '"2026-11-04T01:00:01.654321Z"' },
    ]);
  });

  it("issueEtag() quotes updated_at verbatim, microseconds kept", () => {
    expect(
      issueEtag({ ...ISSUE, updated_at: "2026-11-04T01:00:00.123456Z" }),
    ).toBe('"2026-11-04T01:00:00.123456Z"');
    expect(issueEtag(ISSUE)).toBe('"2026-11-01T10:00:00Z"');
    expect(browserIssueEtag).toBe(issueEtag);
  });

  it("percent-encodes the id", async () => {
    const http = mockHttp();
    await new IssuesApi(http).get("a/b");

    expect(calls(http)[0].path).toBe("/v1/issues/a%2Fb");
  });

  it("types an update without a revision, a nested request or a per-kind list", () => {
    // @ts-expect-error an update carries no revision
    const versioned: IssueUpdateParams = { expected_revision: 1, title: "t" };
    // @ts-expect-error there is no nested request body
    const nested: IssueUpdateParams = { request: { id: COMMENT_ID } };
    // @ts-expect-error evidence changes by add_attachments and remove_attachments
    const replaced: IssueUpdateParams = { links: [] };
    expect([versioned, nested, replaced]).toHaveLength(3);
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
      relation: ["assignee", "reviewer"],
      member_id: MEMBER_ID,
      include: ["members", "attachments"],
      task_status: ["running", "awaiting_user"],
      exclude_task_status: ["completed", "cancelled"],
      display_index: 42,
      display_key: "I-42",
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
    expect(query.getAll("relation")).toEqual(["assignee", "reviewer"]);
    expect(query.get("member_id")).toBe(MEMBER_ID);
    expect(query.getAll("include")).toEqual(["members", "attachments"]);
    expect(query.has("assigned_to_me")).toBe(false);
    expect(query.get("display_index")).toBe("42");
    expect(query.get("display_key")).toBe("I-42");
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

    await sdk.issues.list({
      status: "open",
      relation: "follower",
      next: "cursor-9",
    });

    expect([...sent[0].url.searchParams]).toEqual([
      ["status", "open"],
      ["relation", "follower"],
      ["next", "cursor-9"],
    ]);
    await sdk.shutdown();
  });

  it("sends the issue's ETag back as If-Match only when given", async () => {
    const { sdk, sent } = client((s) =>
      s.method === "DELETE"
        ? new Response(null, { status: 204 })
        : json(ISSUE, s.method === "POST" ? 201 : 200),
    );

    const created = await sdk.issues.create({
      task_id: TASK_ID,
      title: "t",
      description: "d",
    });
    await sdk.issues.update(ISSUE_ID, { remove_attachments: [] });
    await sdk.issues.update(
      ISSUE_ID,
      { status: "closed" },
      { ifMatch: issueEtag(created) },
    );
    await sdk.issues.delete(ISSUE_ID, { ifMatch: issueEtag(created) });

    const tag = `"${ISSUE.updated_at}"`;
    expect(sent.map((s) => [s.method, s.ifMatch])).toEqual([
      ["POST", null],
      ["PATCH", null],
      ["PATCH", tag],
      ["DELETE", tag],
    ]);
    expect(sent[1].body).toEqual({ remove_attachments: [] });
    expect(sent[2].body).toEqual({ status: "closed" });
    await sdk.shutdown();
  });

  it("surfaces a stale If-Match (412) as an IntrospectionAPIError", async () => {
    const { sdk, sent } = client(() =>
      json({ detail: "Issue was changed since it was read" }, 412),
    );

    const err = await sdk.issues
      .update(ISSUE_ID, { title: "t" }, { ifMatch: '"1"' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IntrospectionAPIError);
    expect((err as IntrospectionAPIError).status).toBe(412);
    expect(sent).toHaveLength(1);
    await sdk.shutdown();
  });

  it("sends include on the URL for a read and a comment to its sub-resource", async () => {
    const { sdk, sent } = client((s) =>
      s.method === "POST" ? json(COMMENT, 201) : json(FULL_ISSUE),
    );

    await sdk.issues.get(ISSUE_ID, { include: ["comments"] });
    await sdk.issues.update(ISSUE_ID, { assignee_member_id: null });
    const comment = await sdk.issues.comments.create(ISSUE_ID, {
      comment: "Raised to 60s.",
    });

    expect(sent[0].url.searchParams.getAll("include")).toEqual(["comments"]);
    expect(sent[1].body).toEqual({ assignee_member_id: null });
    expect(sent[2].method).toBe("POST");
    expect(sent[2].url.pathname).toBe(`/v1/issues/${ISSUE_ID}/comments`);
    expect(sent[2].body).toEqual({ comment: "Raised to 60s." });
    expect(comment.issue_id).toBe(ISSUE_ID);
    await sdk.shutdown();
  });

  it("creates an issue without a task and decodes its null task under strictSchema", async () => {
    const sent: unknown[] = [];
    const sdk = new IntrospectionClient({
      token: "intro_test",
      advanced: {
        baseApiUrl: "https://cp.test",
        dpUrl: "https://dp.test",
        strictSchema: true,
        fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          sent.push(JSON.parse(String(init?.body)));
          return json({ ...ISSUE, task_id: null, task_status: null }, 201);
        }) as unknown as typeof globalThis.fetch,
      },
    });

    const issue = await sdk.issues.create({
      title: "Checkout times out",
      description: "Three conversations hit a timeout.",
    });

    expect(sent).toEqual([
      {
        title: "Checkout times out",
        description: "Three conversations hit a timeout.",
      },
    ]);
    expect(issue.task_id).toBeNull();
    expect(issue.task_status).toBeNull();
    await sdk.shutdown();
  });

  it("decodes attachments, an unknown kind included, under strictSchema", async () => {
    const commit = { id: LINK_ATTACHMENT_ID, kind: "commit", sha: "abc" };
    const sdk = new IntrospectionClient({
      token: "intro_test",
      advanced: {
        baseApiUrl: "https://cp.test",
        dpUrl: "https://dp.test",
        strictSchema: true,
        fetch: vi.fn(async () =>
          json({ ...FULL_ISSUE, attachments: [...ATTACHMENTS, commit] }),
        ) as unknown as typeof globalThis.fetch,
      },
    });

    const issue = await sdk.issues.get(ISSUE_ID, { include: ["attachments"] });
    expect(issue.attachments).toHaveLength(5);
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
    expect(api.issues.comments.create).toBeTypeOf("function");
  });
});
