import { describe, expect, it, vi } from "vitest";
import {
  BrowserHttpClient,
  ConversationsClient,
  ConversationItemsClient,
  IntrospectionApiClient,
} from "@introspection-sdk/introspection-browser/api";

// Browser Conversations client unit tests. The DP `http` is injected, so
// no network boundary is crossed (AGENTS.md §6 case 1).

function mockHttp(overrides: Record<string, unknown> = {}) {
  return {
    request: vi.fn().mockResolvedValue(overrides.requestResult ?? {}),
    stream: vi.fn().mockResolvedValue(overrides.streamResult ?? new Response()),
  } as unknown as BrowserHttpClient;
}

const SUMMARY_FIXTURE = {
  object: "conversation",
  id: "conv-1",
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:05Z",
  usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  cost: { usd: 0.01 },
  metrics: {
    duration_ms: 5000,
    trace_count: 1,
    span_count: 3,
    tool_use_count: 0,
    failed_tool_use_count: 0,
    has_errors: false,
  },
};

describe("browser ConversationsClient", () => {
  it("list() walks /v1/conversations with the cursor envelope", async () => {
    const http = mockHttp({
      requestResult: { records: [SUMMARY_FIXTURE], count: 1, next: null },
    });
    const conversations = new ConversationsClient(http);
    const page = await conversations.list({ limit: 10 });

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/conversations",
      query: { limit: 10, next: undefined },
    });
    expect(page.records).toHaveLength(1);
    expect(page.records[0].id).toBe("conv-1");
  });

  it("items.list() drives the opaque `next` cursor across pages", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ trace_id: "trace-1", span_id: "span-1", attributes: {} }],
        has_more: true,
        last_id: "span-1",
        next: "cursor-page-2",
      })
      .mockResolvedValueOnce({
        data: [{ trace_id: "trace-1", span_id: "span-2", attributes: {} }],
        has_more: false,
        last_id: "span-2",
        next: null,
      });
    const http = { request } as unknown as BrowserHttpClient;
    const items = new ConversationItemsClient(http);

    const ids: (string | undefined)[] = [];
    for await (const span of items.list("conv-1", { order: "asc" })) {
      ids.push(span.span_id);
    }

    expect(ids).toEqual(["span-1", "span-2"]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1][0].query.next).toBe("cursor-page-2");
  });

  it("items.get() reads a single item with the surviving includes", async () => {
    const http = mockHttp({
      requestResult: { trace_id: "trace-1", span_id: "span-1", attributes: {} },
    });
    const items = new ConversationItemsClient(http);
    await items.get("conv-1", "span-1", { include: ["events"] });

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/conversations/conv-1/items/span-1",
      query: { include: ["events"] },
    });
  });

  it("retrieve(id, itemId) resolves a turn into the span itself", async () => {
    const http = mockHttp({
      requestResult: {
        trace_id: "trace-1",
        span_id: "span-9",
        start_time: "2025-01-01T00:00:00Z",
        attributes: {
          gen_ai: {
            operation: { name: "chat" },
            provider: { name: "openai" },
            response: { id: "resp-1", model: "gpt-4o" },
            output: {
              messages: [
                { role: "assistant", parts: [{ type: "text", content: "hi" }] },
              ],
            },
          },
        },
      },
    });
    const conversations = new ConversationsClient(http);
    const span = await conversations.retrieve("conv-1", "span-9");

    expect(span).not.toBeNull();
    expect(span?.span_id).toBe("span-9");
    expect(span?.attributes.gen_ai?.response?.model).toBe("gpt-4o");
    expect(span?.attributes.gen_ai?.output?.messages).toHaveLength(1);
    // The detail route is hit directly — the full history comes back with no
    // `include` to remember.
    const call = (http.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.path).toBe("/v1/conversations/conv-1/items/span-9");
    expect(call.query).toBeUndefined();
  });

  it("retrieve() returns null for an empty conversation", async () => {
    // items.list() yields nothing -> no latest turn -> null
    const http = mockHttp({
      requestResult: { data: [], has_more: false, last_id: null, next: null },
    });
    const conversations = new ConversationsClient(http);
    const span = await conversations.retrieve("conv-empty");
    expect(span).toBeNull();
  });

  it("is exposed on IntrospectionApiClient.conversations", () => {
    const client = new IntrospectionApiClient({
      dpUrl: "https://dp.example.com",
      projectId: "proj-1",
      getToken: () => "token",
      fetch: vi.fn() as unknown as typeof fetch,
    });
    expect(client.conversations).toBeInstanceOf(ConversationsClient);
  });
});
