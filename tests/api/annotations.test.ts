import { createServer, type IncomingMessage, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ConflictError,
  IntrospectionClient,
  NotFoundError,
  ValidationError,
  type AnnotationState,
  type AnnotationTarget,
  type ProjectLabel,
} from "@introspection-sdk/introspection-node";

interface CapturedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  authorization?: string;
  cookie?: string;
}

const TARGET: AnnotationTarget = {
  trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  span_id: "bbbbbbbbbbbbbbbb",
};
const ALICE_ID = "11111111-1111-1111-1111-111111111111";
const BOB_ID = "22222222-2222-2222-2222-222222222222";
const EVENT_ID = "018f6b66-4d3a-7abc-8def-0123456789ab";
const UUID_V7_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const ANNOTATION: AnnotationState = {
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
  is_deactivated: false,
};
const BOB = {
  id: BOB_ID,
  email: "bob@example.com",
  is_deactivated: false,
};

let server: Server;
let baseUrl: string;
let requests: CapturedRequest[] = [];
let memberScenario: "normal" | "unknown" | "ambiguous" = "normal";
let rateLimitNextAnnotation = false;

function page<T>(records: T[], next: string | null = null) {
  return { records, count: records.length, total_count: records.length, next };
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
      const second = url.searchParams.get("next") === "annotation-page-2";
      return json(
        res,
        200,
        second
          ? page([{ ...ANNOTATION, span_id: "cccccccccccccccc" }])
          : page([ANNOTATION], "annotation-page-2"),
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
    if (path === "/v1/events" && method === "GET") {
      return json(
        res,
        200,
        page([
          {
            id: EVENT_ID,
            timestamp: "2026-08-25T01:02:03Z",
            event_name: "introspection.annotation",
            ...TARGET,
            payload: {
              member_id: ALICE_ID,
              labels: ["good-structure"],
              comment: null,
              assignee_member_ids: null,
            },
          },
        ]),
      );
    }
    if (path === "/v1/project-labels" && method === "GET") {
      const second = url.searchParams.get("next") === "label-page-2";
      return json(
        res,
        200,
        second
          ? page([{ ...LABEL, slug: "bad-citation" }])
          : page([LABEL], "label-page-2"),
      );
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
      const second = url.searchParams.get("next") === "member-page-2";
      if (memberScenario === "unknown") {
        return json(res, 200, page(second ? [] : [ALICE]));
      }
      if (memberScenario === "ambiguous") {
        const duplicate = { ...ALICE, id: BOB_ID };
        return json(
          res,
          200,
          second ? page([duplicate]) : page([ALICE], "member-page-2"),
        );
      }
      const inactive = {
        ...ALICE,
        id: "44444444-4444-4444-4444-444444444444",
        is_deactivated: true,
      };
      return json(
        res,
        200,
        second ? page([BOB]) : page([ALICE, inactive], "member-page-2"),
      );
    }
    return json(res, 404, { detail: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(
  () =>
    new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ),
);

beforeEach(() => {
  requests = [];
  memberScenario = "normal";
  rateLimitNextAnnotation = false;
});

function client(dpUrl?: string): IntrospectionClient {
  return new IntrospectionClient({
    token: "member-token",
    cpSession: "encoded-member-session",
    advanced: { baseApiUrl: baseUrl, dpUrl },
  });
}

describe("annotations", () => {
  it("lists folded state with every filter and cursor pagination", async () => {
    const listing = client().annotations.list({
      limit: 1,
      include_total: true,
      annotated_by_member_id: BOB_ID,
      assignee_member_id: ALICE_ID,
      trace_id: TARGET.trace_id,
      span_id: TARGET.span_id,
      conversation_id: "conversation-1",
      label: "good-structure",
    });
    expect((await listing).records[0]).toEqual(ANNOTATION);
    const all: AnnotationState[] = [];
    for await (const annotation of listing) all.push(annotation);
    expect(all).toHaveLength(2);
    expect(requests[0]!.query.get("include_total")).toBe("true");
    expect(requests[0]!.query.get("annotated_by_member_id")).toBe(BOB_ID);
    expect(requests[0]!.query.get("assignee_member_id")).toBe(ALICE_ID);
    expect(requests.at(-1)?.query.get("next")).toBe("annotation-page-2");
  });

  it("resolves email list filters once before paginating the data plane", async () => {
    const listing = client().annotations.list({
      annotated_by_email: "bob@example.com",
      assigned_to_email: "alice@example.com",
      limit: 1,
    });
    const all: AnnotationState[] = [];
    for await (const annotation of listing) all.push(annotation);
    expect(all).toHaveLength(2);
    expect(
      requests.filter((request) => request.path === "/v1/members"),
    ).toHaveLength(2);
    const annotationRequests = requests.filter(
      (request) => request.path === "/v1/annotations",
    );
    expect(annotationRequests).toHaveLength(2);
    expect(annotationRequests[0]!.query.get("annotated_by_member_id")).toBe(
      BOB_ID,
    );
    expect(annotationRequests[0]!.query.get("assignee_member_id")).toBe(
      ALICE_ID,
    );
  });

  it("appends one comment, label snapshot, or reviewer snapshot", async () => {
    const api = client().annotations;
    await api.create(TARGET, { comment: "Strong conclusion; weak evidence." });
    await api.create(TARGET, { labels: ["good-structure"] });
    await api.create(TARGET, { labels: [] });
    await api.create(TARGET, {
      reviewerEmails: [" Alice@Example.com ", "bob@example.com"],
    });
    await api.create(TARGET, { reviewerEmails: [] }, { event_id: EVENT_ID });

    const posts = requests.filter(
      (request) => request.path === "/v1/annotations",
    );
    expect(posts[0]!.body).toMatchObject({
      ...TARGET,
      comment: "Strong conclusion; weak evidence.",
    });
    expect(posts[1]!.body).toMatchObject({
      ...TARGET,
      labels: ["good-structure"],
    });
    expect(posts[2]!.body).toMatchObject({ ...TARGET, labels: [] });
    expect(posts[3]!.body).toMatchObject({
      ...TARGET,
      assignee_member_ids: [ALICE_ID, BOB_ID],
    });
    expect(posts[4]!.body).toEqual({
      ...TARGET,
      event_id: EVENT_ID,
      assignee_member_ids: [],
    });
    expect((posts[0]!.body as { event_id: string }).event_id).toMatch(
      UUID_V7_RE,
    );

    if (false) {
      // @ts-expect-error AnnotationMutation forbids combining independent events.
      void api.create(TARGET, { labels: [], comment: "invalid" });
    }
  });

  it("resolves reviewers on CP, writes to DP, and reuses retry identity", async () => {
    rateLimitNextAnnotation = true;
    const split = client(`${baseUrl}/dp`);
    await split.annotations.create(TARGET, {
      reviewerEmails: ["bob@example.com"],
    });
    const memberRequests = requests.filter(
      (request) => request.path === "/v1/members",
    );
    const writes = requests.filter(
      (request) => request.path === "/dp/v1/annotations",
    );
    expect(memberRequests).toHaveLength(2);
    expect(memberRequests[0]!.cookie).toBe(
      "intro_cp_session=encoded-member-session",
    );
    expect(writes).toHaveLength(2);
    expect(writes[0]!.body).toEqual(writes[1]!.body);
    expect(writes[0]!.authorization).toBe("Bearer member-token");
  });

  it("fails closed for missing, ambiguous, empty, and excessive reviewers", async () => {
    memberScenario = "unknown";
    await expect(
      client().annotations.create(TARGET, {
        reviewerEmails: ["missing@example.com"],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
    memberScenario = "ambiguous";
    await expect(
      client().annotations.create(TARGET, {
        reviewerEmails: ["alice@example.com"],
      }),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      client().annotations.create(TARGET, { reviewerEmails: [" "] }),
    ).rejects.toBeInstanceOf(ValidationError);
    const emails = Array.from(
      { length: 65 },
      (_, index) => `expert-${index}@example.com`,
    );
    await expect(
      client().annotations.create(TARGET, { reviewerEmails: emails }),
    ).rejects.toMatchObject({ code: "too_many_annotation_reviewers" });
  });

  it("reads immutable annotation history through generic events", async () => {
    const page = await client().events.list({
      event_name: "introspection.annotation",
      trace_id: TARGET.trace_id,
      span_id: TARGET.span_id,
    });
    expect(page.records[0]!.payload.labels).toEqual(["good-structure"]);
    expect(requests[0]!.query.get("event_name")).toBe(
      "introspection.annotation",
    );
  });
});

describe("project labels", () => {
  it("lists, creates, gets, and updates through the first-class resource", async () => {
    const labels = client().projectLabels;
    const listing = labels.list({ search: "structure", limit: 1 });
    expect((await listing).records[0]).toEqual(LABEL);
    const slugs: string[] = [];
    for await (const label of listing) slugs.push(label.slug);
    expect(slugs).toEqual(["good-structure", "bad-citation"]);
    await labels.create({ slug: LABEL.slug, color: "#F97316" });
    expect(await labels.get(LABEL.slug)).toEqual(LABEL);
    expect(
      await labels.update(LABEL.slug, { description: null }),
    ).toMatchObject({
      description: null,
    });
  });

  it("rejects invalid managed presentation metadata locally", () => {
    expect(() =>
      client().projectLabels.create({ slug: "unsafe", color: "orange" }),
    ).toThrow(ValidationError);
  });
});
