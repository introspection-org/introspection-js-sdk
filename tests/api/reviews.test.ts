/**
 * Qualitative-review REST coverage against a real in-process HTTP server.
 * The server is the API boundary under test; no framework or fetch mocks are
 * used. This exercises serialization, pagination, empty snapshots, member
 * resolution, and the shared HTTP retry path end to end.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ConflictError,
  IntrospectionClient,
  NotFoundError,
  ValidationError,
  type ProjectLabel,
  type ReviewState,
  type ReviewTarget,
} from "@introspection-sdk/introspection-node";

interface CapturedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  authorization?: string;
  cookie?: string;
}

const TARGET: ReviewTarget = {
  trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  span_id: "bbbbbbbbbbbbbbbb",
};
const ALICE_ID = "11111111-1111-1111-1111-111111111111";
const BOB_ID = "22222222-2222-2222-2222-222222222222";
const REQUEST_EVENT_ID = "018f6b66-4d3a-7abc-8def-0123456789ab";
const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const REVIEW: ReviewState = {
  ...TARGET,
  conversation_id: "conversation-1",
  labels: ["good-structure"],
  assignee_member_ids: [ALICE_ID],
  annotator_member_ids: [BOB_ID],
  has_comment: true,
  comment_count: 2,
  latest_comment: "The conclusion is strong.",
  latest_comment_member_id: BOB_ID,
  updated_at: "2026-08-25T01:02:03Z",
  updated_by_member_id: BOB_ID,
  assignment_event_id: "33333333-3333-3333-3333-333333333333",
};

const LABEL: ProjectLabel = {
  slug: "good-structure",
  color: "#f97316",
  description: "Preserves the useful answer structure",
  created_at: "2026-08-25T01:00:00Z",
  updated_at: "2026-08-25T01:00:00Z",
};

const ALICE = {
  id: ALICE_ID,
  email: "alice@example.com",
  name: "Alice Expert",
  member_type: "business",
  is_deactivated: false,
};
const BOB = {
  id: BOB_ID,
  email: "bob@example.com",
  name: "Bob Expert",
  member_type: "business",
  is_deactivated: false,
};

let server: Server;
let baseUrl: string;
let requests: CapturedRequest[] = [];
let memberScenario: "normal" | "unknown" | "ambiguous" = "normal";
let rateLimitNextAnnotation = false;
let reviewAssignees = [ALICE_ID];

function page<T>(records: T[], next: string | null = null) {
  return {
    records,
    count: records.length,
    total_count: records.length,
    next,
  };
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      resolve(raw ? JSON.parse(raw) : undefined);
    });
  });
}

function json(
  res: import("node:http").ServerResponse,
  status: number,
  payload: unknown,
) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const method = req.method ?? "GET";
    const body = await readBody(req);
    requests.push({
      method,
      path: url.pathname,
      query: url.searchParams,
      body,
      authorization: req.headers.authorization,
      cookie: req.headers.cookie,
    });
    const path = url.pathname.startsWith("/dp/")
      ? url.pathname.slice(3)
      : url.pathname;

    if (path === "/v1/annotations" && method === "GET") {
      if (url.searchParams.get("next") === "review-page-2") {
        return json(
          res,
          200,
          page([{ ...REVIEW, span_id: "cccccccccccccccc" }]),
        );
      }
      return json(
        res,
        200,
        page(
          [{ ...REVIEW, assignee_member_ids: reviewAssignees }],
          "review-page-2",
        ),
      );
    }
    if (path === "/v1/annotations" && method === "POST") {
      if (rateLimitNextAnnotation) {
        rateLimitNextAnnotation = false;
        res.writeHead(429, {
          "content-type": "application/json",
          "retry-after": "0",
        });
        return res.end(JSON.stringify({ detail: "slow down" }));
      }
      res.writeHead(204);
      return res.end();
    }
    if (path === "/v1/project-labels" && method === "GET") {
      if (url.searchParams.get("next") === "label-page-2") {
        return json(res, 200, page([{ ...LABEL, slug: "bad-citation" }]));
      }
      return json(res, 200, page([LABEL], "label-page-2"));
    }
    if (path === "/v1/project-labels" && method === "POST") {
      return json(res, 201, { ...LABEL, ...(body as object) });
    }
    if (path === `/v1/project-labels/${LABEL.slug}` && method === "GET") {
      return json(res, 200, LABEL);
    }
    if (path === `/v1/project-labels/${LABEL.slug}` && method === "PATCH") {
      return json(res, 200, { ...LABEL, ...(body as object) });
    }
    if (path === "/v1/members" && method === "GET") {
      const secondPage = url.searchParams.get("next") === "member-page-2";
      if (memberScenario === "unknown") {
        return json(res, 200, page(secondPage ? [] : [ALICE]));
      }
      if (memberScenario === "ambiguous") {
        const duplicate = { ...ALICE, id: BOB_ID, name: "Other Alice" };
        return json(
          res,
          200,
          secondPage ? page([duplicate]) : page([ALICE], "member-page-2"),
        );
      }
      const inactiveDuplicate = {
        ...ALICE,
        id: "44444444-4444-4444-4444-444444444444",
        is_deactivated: true,
      };
      return json(
        res,
        200,
        secondPage
          ? page([BOB])
          : page([ALICE, inactiveDuplicate], "member-page-2"),
      );
    }

    return json(res, 404, { detail: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

beforeEach(() => {
  requests = [];
  memberScenario = "normal";
  rateLimitNextAnnotation = false;
  reviewAssignees = [ALICE_ID];
});

function client(): IntrospectionClient {
  return new IntrospectionClient({
    token: "member-token",
    advanced: { baseApiUrl: baseUrl },
  });
}

describe("qualitative reviews", () => {
  it("returns typed folded states and lazily paginates every filter", async () => {
    const api = client().reviews;
    const listing = api.list({
      limit: 1,
      include_total: true,
      annotated_by_member_id: BOB_ID,
      assignee_member_id: ALICE_ID,
      trace_id: TARGET.trace_id,
      span_id: TARGET.span_id,
      conversation_id: "conversation-1",
      label: "good-structure",
    });

    const first = await listing;
    expect(first.records[0]).toEqual(REVIEW);
    const all: ReviewState[] = [];
    for await (const review of listing) all.push(review);
    expect(all).toHaveLength(2);

    const firstRequest = requests[0]!;
    expect(firstRequest.query.get("include_total")).toBe("true");
    expect(firstRequest.query.get("annotated_by_member_id")).toBe(BOB_ID);
    expect(firstRequest.query.get("assignee_member_id")).toBe(ALICE_ID);
    expect(firstRequest.query.get("trace_id")).toBe(TARGET.trace_id);
    expect(firstRequest.query.get("span_id")).toBe(TARGET.span_id);
    expect(firstRequest.query.get("conversation_id")).toBe("conversation-1");
    expect(firstRequest.query.get("label")).toBe("good-structure");
    expect(requests.at(-1)?.query.get("next")).toBe("review-page-2");
  });

  it("sends exactly one mutation and preserves explicit empty clears", async () => {
    const api = client().reviews;
    await api.comment(TARGET, "Strong conclusion; weak evidence.");
    await api.setLabels(TARGET, ["good-structure", "bad-citation"]);
    await api.setLabels(TARGET, []);
    await api.setAssignees(TARGET, [ALICE_ID]);
    await api.clearAssignees(TARGET);

    const bodies = requests.map(
      (request) => request.body as Record<string, unknown>,
    );
    expect(bodies[0]).toMatchObject({
      ...TARGET,
      comment: "Strong conclusion; weak evidence.",
    });
    expect(bodies[1]).toMatchObject({
      ...TARGET,
      labels: ["good-structure", "bad-citation"],
    });
    expect(bodies[2]).toMatchObject({ ...TARGET, labels: [] });
    expect(bodies[3]).toMatchObject({
      ...TARGET,
      assignee_member_ids: [ALICE_ID],
    });
    expect(bodies[4]).toMatchObject({ ...TARGET, assignee_member_ids: [] });
    expect(
      bodies.every(
        (body) =>
          typeof body.event_id === "string" && UUID_V7_RE.test(body.event_id),
      ),
    ).toBe(true);
    expect(new Set(bodies.map((body) => body.event_id)).size).toBe(5);

    if (false) {
      // @ts-expect-error ReviewMutation forbids combining independent events.
      void api.create(TARGET, { labels: [], comment: "invalid" });
    }
  });

  it("mints one UUIDv7 and reuses it across a rejected-write retry", async () => {
    rateLimitNextAnnotation = true;
    await client().reviews.comment(TARGET, "Retry-safe qualitative note");

    expect(requests).toHaveLength(2);
    expect(requests[0]!.body).toEqual(requests[1]!.body);
    expect(requests[0]!.body).toMatchObject({
      ...TARGET,
      comment: "Retry-safe qualitative note",
    });
    expect((requests[0]!.body as { event_id: string }).event_id).toMatch(
      UUID_V7_RE,
    );
  });

  it("preserves an explicit UUIDv7 for a caller-managed replay", async () => {
    await client().reviews.comment(TARGET, "Durable replay", {
      event_id: REQUEST_EVENT_ID,
    });
    expect(requests[0]!.body).toEqual({
      ...TARGET,
      event_id: REQUEST_EVENT_ID,
      comment: "Durable replay",
    });
  });
});

describe("domain-expert assignment by email", () => {
  it("resolves all pages, ignores deactivated members, and deduplicates input", async () => {
    await client().reviews.assignByEmail(TARGET, [
      " Alice@Example.com ",
      "alice@example.com",
      "bob@example.com",
    ]);

    const memberRequests = requests.filter(
      (request) => request.path === "/v1/members",
    );
    expect(memberRequests).toHaveLength(2);
    expect(memberRequests[0]!.query.get("limit")).toBe("1000");
    expect(memberRequests[0]!.query.get("member_type")).toBe("business");
    expect(memberRequests[1]!.query.get("next")).toBe("member-page-2");
    expect(requests.at(-1)?.body).toMatchObject({
      ...TARGET,
      assignee_member_ids: [ALICE_ID, BOB_ID],
    });
  });

  it("resolves members on CP and writes the assignment to the regional DP", async () => {
    const splitClient = new IntrospectionClient({
      token: "member-token",
      cpSession: "encoded-member-session",
      advanced: { baseApiUrl: baseUrl, dpUrl: `${baseUrl}/dp` },
    });
    await splitClient.reviews.assignByEmail(TARGET, "bob@example.com");
    await splitClient.reviews.labels.get(LABEL.slug);

    expect(requests.some((request) => request.path === "/v1/members")).toBe(
      true,
    );
    expect(
      requests.some((request) => request.path === "/dp/v1/annotations"),
    ).toBe(true);
    expect(
      requests.some(
        (request) => request.path === `/dp/v1/project-labels/${LABEL.slug}`,
      ),
    ).toBe(true);
    const memberRequest = requests.find(
      (request) => request.path === "/v1/members",
    );
    const annotationRequest = requests.find(
      (request) => request.path === "/dp/v1/annotations",
    );
    expect(memberRequest?.cookie).toBe(
      "intro_cp_session=encoded-member-session",
    );
    expect(memberRequest?.authorization).toBeUndefined();
    expect(annotationRequest?.authorization).toBe("Bearer member-token");
    expect(annotationRequest?.cookie).toBeUndefined();
  });

  it("removes one assignee by email while preserving the current snapshot", async () => {
    reviewAssignees = [ALICE_ID, BOB_ID];
    await client().reviews.unassignByEmail(TARGET, "alice@example.com", {
      event_id: REQUEST_EVENT_ID,
    });

    expect(requests.at(-1)?.body).toEqual({
      ...TARGET,
      event_id: REQUEST_EVENT_ID,
      assignee_member_ids: [BOB_ID],
    });
  });

  it("does not append an event when the member is already unassigned", async () => {
    await client().reviews.unassignByEmail(TARGET, "bob@example.com");

    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("does not mutate when an email is unknown", async () => {
    memberScenario = "unknown";
    await expect(
      client().reviews.assignByEmail(TARGET, "missing@example.com"),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("does not pick an arbitrary member when an email is ambiguous", async () => {
    memberScenario = "ambiguous";
    await expect(
      client().reviews.assignByEmail(TARGET, "alice@example.com"),
    ).rejects.toBeInstanceOf(ConflictError);
    expect(requests.some((request) => request.method === "POST")).toBe(false);
  });

  it("rejects empty email input before any request", async () => {
    await expect(
      client().reviews.assignByEmail(TARGET, []),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      client().reviews.assignByEmail(TARGET, "  "),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(requests).toEqual([]);
  });

  it("rejects more assignees than the Cloud snapshot contract allows", async () => {
    const emails = Array.from(
      { length: 65 },
      (_, index) => `expert-${index}@example.com`,
    );
    await expect(
      client().reviews.assignByEmail(TARGET, emails),
    ).rejects.toMatchObject({
      code: "too_many_review_assignees",
    });
    expect(requests).toEqual([]);
  });
});

describe("managed review labels", () => {
  it("lists across pages and preserves search", async () => {
    const listing = client().reviews.labels.list({
      limit: 1,
      search: "structure",
    });
    const first = await listing;
    expect(first.records[0]).toEqual(LABEL);
    const slugs: string[] = [];
    for await (const label of listing) slugs.push(label.slug);
    expect(slugs).toEqual(["good-structure", "bad-citation"]);
    expect(requests[0]!.query.get("search")).toBe("structure");
    expect(requests.at(-1)?.query.get("next")).toBe("label-page-2");
  });

  it("creates, gets, and only updates the optional description", async () => {
    const labels = client().reviews.labels;
    const created: ProjectLabel = await labels.create({
      slug: "good-structure",
      color: "#F97316",
      description: "Preserves the useful answer structure",
    });
    const found: ProjectLabel = await labels.get("good-structure");
    const updated: ProjectLabel = await labels.update("good-structure", {
      description: null,
    });

    expect(created.slug).toBe("good-structure");
    expect(found).toEqual(LABEL);
    expect(updated.description).toBeNull();
    expect(requests.map((request) => request.body)).toEqual([
      {
        slug: "good-structure",
        color: "#f97316",
        description: "Preserves the useful answer structure",
      },
      undefined,
      { description: null },
    ]);
  });

  it("rejects unsafe label presentation metadata before the network", async () => {
    const labels = client().reviews.labels;
    expect(() => labels.create({ slug: "unsafe", color: "orange" })).toThrow(
      ValidationError,
    );
    expect(() => labels.create({ slug: "unsafe", color: "#12zz89" })).toThrow(
      ValidationError,
    );
    expect(() =>
      labels.create({
        slug: "unsafe",
        color: "#f97316",
        description: "x".repeat(2_001),
      }),
    ).toThrow(ValidationError);
    expect(requests).toHaveLength(0);
  });
});
