import { describe, expect, it, vi } from "vitest";
import {
  HttpClient,
  AnnotationsApi,
} from "@introspection-sdk/introspection-node";

function mockHttp(overrides: Record<string, unknown> = {}) {
  return {
    request: vi.fn().mockResolvedValue(overrides.requestResult ?? {}),
    stream: vi.fn().mockResolvedValue(overrides.streamResult ?? new Response()),
  } as unknown as HttpClient;
}

const ANNOTATION_FIXTURE = {
  id: "ann-1",
  org_id: "org-1",
  project_id: "proj-1",
  conversation_id: "conv-1",
  kind: "mark" as const,
  parent_id: null,
  selection: null,
  labels: ["tone"],
  comment: "Too formal",
  member_id: "member-1",
  actor_member_id: null,
  actor_type: null,
  share_id: null,
  dataset_id: null,
  completed_at: null,
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
};

describe("AnnotationsApi", () => {
  it("list() calls GET /v1/annotations with filters", async () => {
    const http = mockHttp({
      requestResult: {
        records: [ANNOTATION_FIXTURE],
        count: 1,
        total_count: 1,
        next: null,
      },
    });
    const api = new AnnotationsApi(http);
    const annotations = [];
    for await (const a of api.list({
      kind: "review",
      conversation_id: "conv-1",
      pending: true,
      label: "tone",
      limit: 5,
    })) {
      annotations.push(a);
    }

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/annotations",
      query: {
        kind: "review",
        conversation_id: "conv-1",
        pending: true,
        label: "tone",
        limit: 5,
      },
    });
    expect(annotations).toHaveLength(1);
  });

  it("list() paginates through all pages", async () => {
    const page1 = {
      records: [ANNOTATION_FIXTURE],
      count: 1,
      total_count: 2,
      next: "cur2",
    };
    const page2 = {
      records: [{ ...ANNOTATION_FIXTURE, id: "ann-2" }],
      count: 1,
      total_count: 2,
      next: null,
    };
    const http = mockHttp();
    (http.request as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);

    const api = new AnnotationsApi(http);
    const annotations = [];
    for await (const a of api.list()) annotations.push(a);

    expect(annotations).toHaveLength(2);
    expect(http.request).toHaveBeenCalledTimes(2);
  });

  it("create() calls POST /v1/annotations with the body", async () => {
    const http = mockHttp({ requestResult: ANNOTATION_FIXTURE });
    const api = new AnnotationsApi(http);
    await api.create({
      conversation_id: "conv-1",
      kind: "mark",
      selection: { message_id: "msg-1", quoted_text: "hello" },
      labels: ["tone"],
      comment: "Too formal",
    });

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/annotations",
      body: {
        conversation_id: "conv-1",
        kind: "mark",
        selection: { message_id: "msg-1", quoted_text: "hello" },
        labels: ["tone"],
        comment: "Too formal",
      },
    });
  });

  it("get() calls GET /v1/annotations/:id", async () => {
    const http = mockHttp({ requestResult: ANNOTATION_FIXTURE });
    const api = new AnnotationsApi(http);
    await api.get("ann-1");

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/annotations/ann-1",
    });
  });

  it("update() calls PATCH /v1/annotations/:id", async () => {
    const http = mockHttp({ requestResult: ANNOTATION_FIXTURE });
    const api = new AnnotationsApi(http);
    await api.update("ann-1", { completed: true });

    expect(http.request).toHaveBeenCalledWith({
      method: "PATCH",
      path: "/v1/annotations/ann-1",
      body: { completed: true },
    });
  });

  it("update() replaces the label list wholesale, including clearing it", async () => {
    const http = mockHttp({ requestResult: ANNOTATION_FIXTURE });
    await new AnnotationsApi(http).update("ann-1", { labels: [] });

    // Replaces wholesale, so [] must reach the wire rather than be dropped.
    expect(http.request).toHaveBeenCalledWith({
      method: "PATCH",
      path: "/v1/annotations/ann-1",
      body: { labels: [] },
    });
  });

  it("delete() calls DELETE /v1/annotations/:id with empty expect", async () => {
    const http = mockHttp();
    const api = new AnnotationsApi(http);
    await api.delete("ann-1");

    expect(http.request).toHaveBeenCalledWith({
      method: "DELETE",
      path: "/v1/annotations/ann-1",
      expect: "empty",
    });
  });

  it("URL-encodes annotation IDs", async () => {
    const http = mockHttp({ requestResult: ANNOTATION_FIXTURE });
    const api = new AnnotationsApi(http);
    await api.get("ann/special id");

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/annotations/ann%2Fspecial%20id",
    });
  });
});
