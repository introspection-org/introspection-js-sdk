/**
 * Strict decoding: with `INTROSPECTION_STRICT_SCHEMA=1` (or `strictSchema:
 * true`) a response field the SDK does not model throws `SchemaDriftError`,
 * naming the route and every field by its JSON path.
 *
 * A fake `fetch` stands in for the server, so no network boundary is crossed
 * (AGENTS.md §6 case 1, as in `issues.test.ts`): the payloads carry fields no
 * server sends, which a recording cannot hold. Every resource method under
 * test is the real one; the walk replays its recordings strictly for the
 * real responses.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ConnectionsApi,
  ConversationsApi,
  EventsApi,
  HttpClient,
  ImagesApi,
  IntrospectionAPIError,
  ProjectsApi,
  SchemaDriftError,
} from "@introspection-sdk/introspection-node";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function client(body: unknown, strictSchema?: boolean): HttpClient {
  return new HttpClient({
    apiUrl: "https://api.example.com",
    token: "test-token",
    fetch: (() => Promise.resolve(jsonResponse(body))) as typeof fetch,
    maxRetries: 0,
    strictSchema,
  });
}

const IMAGE = { id: "img-1", name: "base", content_id: "c1" };

function page(records: unknown[], extra: Record<string, unknown> = {}) {
  return {
    records,
    count: records.length,
    total_count: null,
    next: null,
    ...extra,
  };
}

function span(introspection: Record<string, unknown> = {}) {
  return {
    trace_id: "t1",
    span_id: "s1",
    start_time: "2026-11-06T00:00:00Z",
    resource: { service: { name: "agent", version: "1.2.3" } },
    events: [
      { timestamp: "2026-11-06T00:00:00Z", name: "e", attributes: { k: 1 } },
    ],
    attributes: {
      // Open by design: the gen_ai.* nodes, the GenAI messages and parts,
      // and the attribute families the SDK does not type.
      gen_ai: {
        operation: { name: "chat", novel: true },
        usage: { input_tokens: 3, cache_write_tokens: 1 },
        output: {
          messages: [
            {
              role: "assistant",
              parts: [{ type: "text", content: "hi", x: 1 }],
            },
          ],
        },
        brand_new_family: { anything: 1 },
      },
      customer: { tenant: "acme" },
      introspection: { org: { id: "org-1" }, ...introspection },
    },
  };
}

function spanList(data: unknown[], extra: Record<string, unknown> = {}) {
  return {
    object: "list",
    data,
    first_id: null,
    last_id: null,
    has_more: false,
    next: null,
    ...extra,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("strict decoding off (the default)", () => {
  it("tolerates a field the SDK does not model", async () => {
    vi.stubEnv("INTROSPECTION_STRICT_SCHEMA", "");
    const images = new ImagesApi(client({ ...IMAGE, color: "red" }));
    await expect(images.get("img-1")).resolves.toMatchObject({ color: "red" });
  });

  it("stays off when the option says so, whatever the environment", async () => {
    vi.stubEnv("INTROSPECTION_STRICT_SCHEMA", "1");
    const images = new ImagesApi(client({ ...IMAGE, color: "red" }, false));
    await expect(images.get("img-1")).resolves.toMatchObject({ color: "red" });
  });
});

describe("strict decoding on", () => {
  it("names the route and each unmodelled field, list index included", async () => {
    const body = page([IMAGE, { ...IMAGE, color: "red" }], { cursor_v2: "x" });
    const images = new ImagesApi(client(body, true));
    const error = await images.list().then(
      () => null,
      (err: unknown) => err,
    );
    expect(error).toBeInstanceOf(SchemaDriftError);
    expect(error).toBeInstanceOf(IntrospectionAPIError);
    const drift = error as SchemaDriftError;
    expect(drift.message).toBe(
      "/v1/images: response fields this SDK does not model: $.records[1].color, $.cursor_v2",
    );
    expect(drift.path).toBe("/v1/images");
    expect(drift.fields).toEqual(["$.records[1].color", "$.cursor_v2"]);
    expect(drift.code).toBe("schema_drift");
  });

  it("turns on from INTROSPECTION_STRICT_SCHEMA", async () => {
    vi.stubEnv("INTROSPECTION_STRICT_SCHEMA", "1");
    const images = new ImagesApi(client({ ...IMAGE, color: "red" }));
    await expect(images.get("img-1")).rejects.toThrow(
      "/v1/images/img-1: response fields this SDK does not model: $.color",
    );
  });

  it("reports a nested span attribute by its path", async () => {
    const body = spanList([span(), span({ novel: 1 })]);
    const conversations = new ConversationsApi(client(body, true));
    await expect(conversations.exportJson("conv-1")).rejects.toThrow(
      "/v1/conversations/conv-1/export: response fields this SDK does not model: $.data[1].attributes.introspection.novel",
    );
  });

  it("accepts the modelled introspection.* attributes and open maps", async () => {
    const body = spanList(
      [
        span({
          tool_call_ids: ["call-1"],
          tool_response_ids: ["call-0"],
          agent: { kind: "session", depth: "0", invocation_index: 1 },
          run: { id: "r1", root_id: "r0" },
          task: { id: "t1", run_id: "r1" },
          invocation: { kind: "turn" },
          ingest: { host: "processor-0", time: 1 },
          byok: false,
          termination_reason: "completed",
        }),
      ],
      { compaction: { applied: false, history: [] } },
    );
    const conversations = new ConversationsApi(client(body, true));
    const spans = await conversations.exportJson("conv-1");
    expect(spans.data[0]?.attributes.introspection?.tool_call_ids).toEqual([
      "call-1",
    ]);
  });

  it("models a project's git origin", async () => {
    const projects = new ProjectsApi(
      client(
        {
          id: "p1",
          org_id: "o1",
          deployment_id: "d1",
          name: "Main",
          description: null,
          git_origin: "https://git.example.test",
        },
        true,
      ),
    );
    await expect(projects.get("p1")).resolves.toMatchObject({
      git_origin: "https://git.example.test",
    });
  });

  it("checks the envelope, even around an empty list", async () => {
    const images = new ImagesApi(client(page([], { cursor_v2: "x" }), true));
    await expect(images.list()).rejects.toThrow(
      "/v1/images: response fields this SDK does not model: $.cursor_v2",
    );
  });

  it("picks the union branch a response matches", async () => {
    const connections = new ConnectionsApi(
      client(
        {
          status: "authorization_pending",
          mission_id: "m1",
          approval_url: "https://example.com",
          poll_after: 5,
        },
        true,
      ),
    );
    await expect(connections.getToken("conn-1")).rejects.toThrow(
      "/v1/oauth/connections/token: response fields this SDK does not model: $.poll_after",
    );
    const ok = new ConnectionsApi(
      client({ token: "t", token_type: "bearer", scopes: [] }, true),
    );
    await expect(ok.getToken("conn-1")).resolves.toMatchObject({ token: "t" });
  });

  it("checks a known event family's payload, not only the open fallback", async () => {
    const event = {
      id: "e1",
      timestamp: "2026-11-06T00:00:00Z",
      event_name: "introspection.feedback",
      payload: { name: "thumbs_up", novel: 1 },
    };
    const events = new EventsApi(client(event, true));
    await expect(events.get("e1")).rejects.toThrow(
      "/v1/events/e1: response fields this SDK does not model: $.payload.novel",
    );
    const later = new EventsApi(
      client(
        {
          ...event,
          event_name: "introspection.added_later",
          payload: { x: 1 },
        },
        true,
      ),
    );
    await expect(later.get("e1")).resolves.toMatchObject({ payload: { x: 1 } });
  });

  it("checks an event page", async () => {
    const events = new EventsApi(
      client(
        page([
          {
            id: "e1",
            timestamp: "2026-11-06T00:00:00Z",
            event_name: "introspection.feedback",
            payload: { name: "thumbs_up" },
            shard: 3,
          },
        ]),
        true,
      ),
    );
    await expect(
      events.list({ event_name: "introspection.feedback", lookback: "24h" }),
    ).rejects.toThrow(
      "/v1/events: response fields this SDK does not model: $.records[0].shard",
    );
  });

  it("leaves a request that names no schema alone", async () => {
    const http = client({ anything: 1 }, true);
    await expect(
      http.request<{ anything: number }>({ method: "GET", path: "/v1/raw" }),
    ).resolves.toEqual({ anything: 1 });
  });

  it("fails loudly on a schema key the generated file lacks", async () => {
    const http = client({}, true);
    await expect(
      http.request<object>({
        method: "GET",
        path: "/v1/raw",
        schema: "NotGenerated",
      }),
    ).rejects.toThrow('strict schema: no schema for "NotGenerated"');
  });
});
