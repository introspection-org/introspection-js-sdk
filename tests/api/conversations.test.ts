import { describe, expect, it, vi } from "vitest";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import {
  ConversationsApi,
  HttpClient,
} from "@introspection-sdk/introspection-node";
import type {
  ConversationItem,
  ConversationItemList,
} from "@introspection-sdk/introspection-node";

function mockHttp(overrides: Record<string, unknown> = {}) {
  return {
    request: vi.fn().mockResolvedValue(overrides.requestResult ?? {}),
    stream: vi.fn().mockResolvedValue(overrides.streamResult ?? new Response()),
  } as unknown as HttpClient;
}

const SUMMARY_FIXTURE = {
  trace_id: "trace-1",
  conversation_id: "conv-1",
  org_id: "org-1",
  project_id: "proj-1",
  start_time: "2025-01-01T00:00:00Z",
  end_time: "2025-01-01T00:00:05Z",
  duration_ms: 5000,
  model: "claude-x",
  agent_name: "agent",
  total_input_tokens: 10,
  total_output_tokens: 20,
  total_tokens: 30,
  total_cost_usd: 0.01,
  tool_use_count: 0,
  failed_tool_use_count: 0,
  trace_count: 1,
  span_count: 3,
  status: "Ok" as const,
  has_errors: false,
  input_messages: [],
  output_messages: [],
};

function makeItem(overrides: Partial<ConversationItem> = {}): ConversationItem {
  return {
    object: "conversation.item",
    id: "item-1",
    type: "span",
    trace_id: "trace-1",
    span_id: "span-1",
    created_at: "2025-01-01T00:00:00Z",
    span_name: "chat anthropic",
    span_kind: "CLIENT",
    node_type: "span",
    input_messages: [],
    ...overrides,
  };
}

function makePage(
  data: ConversationItem[],
  has_more: boolean,
): ConversationItemList {
  return {
    object: "list",
    data,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
    has_more,
  };
}

describe("ConversationsApi", () => {
  it("list() calls GET /v1/conversations with filters", async () => {
    const http = mockHttp({
      requestResult: {
        records: [SUMMARY_FIXTURE],
        count: 1,
        total_count: 1,
        next: null,
      },
    });
    const api = new ConversationsApi(http);
    const summaries = [];
    for await (const c of api.list({
      limit: 10,
      status: "Error",
      model: "claude-x",
    })) {
      summaries.push(c);
    }

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/conversations",
      query: { limit: 10, status: "Error", model: "claude-x" },
    });
    expect(summaries).toHaveLength(1);
  });

  it("list() drives the cursor `next` token until exhausted", async () => {
    const page1 = {
      records: [SUMMARY_FIXTURE],
      count: 1,
      total_count: 2,
      next: "cursor-2",
    };
    const page2 = {
      records: [{ ...SUMMARY_FIXTURE, trace_id: "trace-2" }],
      count: 1,
      total_count: 2,
      next: null,
    };
    const http = mockHttp();
    (http.request as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);

    const api = new ConversationsApi(http);
    const summaries = [];
    for await (const c of api.list()) summaries.push(c);

    expect(summaries).toHaveLength(2);
    expect(summaries[1].trace_id).toBe("trace-2");
    expect(http.request).toHaveBeenCalledTimes(2);
    expect(
      (http.request as ReturnType<typeof vi.fn>).mock.calls[1][0].query.next,
    ).toBe("cursor-2");
  });

  it("items.list() calls GET /v1/conversations/:id/items with includes", async () => {
    const http = mockHttp({ requestResult: makePage([makeItem()], false) });
    const api = new ConversationsApi(http);
    const items = [];
    for await (const item of api.items.list("conv-1", {
      order: "asc",
      include: ["events", "span_attributes"],
    })) {
      items.push(item);
    }

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/conversations/conv-1/items",
      query: { order: "asc", include: ["events", "span_attributes"] },
    });
    expect(items).toHaveLength(1);
  });

  it("items.list() drives `after` = last_id while has_more, then stops", async () => {
    const page1 = makePage(
      [makeItem({ id: "item-1" }), makeItem({ id: "item-2" })],
      true,
    );
    const page2 = makePage([makeItem({ id: "item-3" })], false);
    const http = mockHttp();
    (http.request as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);

    const api = new ConversationsApi(http);
    const items = [];
    for await (const item of api.items.list("conv-1")) items.push(item);

    expect(items.map((i) => i.id)).toEqual(["item-1", "item-2", "item-3"]);
    expect(http.request).toHaveBeenCalledTimes(2);
    const calls = (http.request as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].query.after).toBeUndefined();
    expect(calls[1][0].query.after).toBe("item-2");
  });

  it("items.list() terminates on an empty page (has_more=false, last_id=null)", async () => {
    const http = mockHttp({ requestResult: makePage([], false) });
    const api = new ConversationsApi(http);
    const items = [];
    for await (const item of api.items.list("conv-1")) items.push(item);

    expect(items).toHaveLength(0);
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it("items.list() walks the ascending transcript when order=asc", async () => {
    const page1 = makePage([makeItem({ id: "item-1" })], true);
    const page2 = makePage([makeItem({ id: "item-2" })], false);
    const http = mockHttp();
    (http.request as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);

    const api = new ConversationsApi(http);
    const items = [];
    for await (const item of api.items.list("conv-1", { order: "asc" })) {
      items.push(item);
    }

    expect(items.map((i) => i.id)).toEqual(["item-1", "item-2"]);
    const calls = (http.request as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].query.order).toBe("asc");
    expect(calls[1][0].query.order).toBe("asc");
  });

  it("items.get() URL-encodes path segments", async () => {
    const http = mockHttp({ requestResult: makeItem() });
    const api = new ConversationsApi(http);
    await api.items.get("conv/with spaces", "item:1", {
      include: ["gen_ai.input.messages"],
    });

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/conversations/conv%2Fwith%20spaces/items/item%3A1",
      query: { include: ["gen_ai.input.messages"] },
    });
  });

  it("retrieve() picks the latest assistant turn and fetches the detail", async () => {
    // Descending order: a tool_call span first, then the assistant turn.
    const listPage = makePage(
      [
        makeItem({ id: "item-3", node_type: "tool_call" }),
        makeItem({ id: "item-2", node_type: "assistant" }),
        makeItem({ id: "item-1", node_type: "span" }),
      ],
      false,
    );
    const detail = makeItem({
      id: "item-2",
      node_type: "assistant",
      response_id: "resp-2",
      model_name: "claude-x",
      provider_name: "anthropic",
      created_at: "2025-01-01T00:00:02Z",
      input_messages: [
        { role: "user", parts: [{ type: "text", content: "hi" }] },
      ],
      output_message: {
        role: "assistant",
        parts: [{ type: "text", content: "hello" }],
        finish_reason: "stop",
      },
      system_instructions: [{ type: "text", content: "be nice" }],
      tool_definitions: [{ name: "lookup" }],
    });
    const http = mockHttp();
    (http.request as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(listPage)
      .mockResolvedValueOnce(detail);

    const api = new ConversationsApi(http);
    const response = await api.retrieve("conv-1");

    const calls = (http.request as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].query.order).toBe("desc");
    expect(calls[1][0]).toEqual({
      method: "GET",
      path: "/v1/conversations/conv-1/items/item-2",
      query: {
        include: [
          "gen_ai.input.messages",
          "gen_ai.system_instructions",
          "gen_ai.tool.definitions",
        ],
      },
    });
    expect(response).not.toBeNull();
    expect(response!.item_id).toBe("item-2");
    expect(response!.response_id).toBe("resp-2");
    expect(response!.model).toBe("claude-x");
    expect(response!.provider_name).toBe("anthropic");
    expect(response!.created_at).toBe("2025-01-01T00:00:02Z");
    expect(response!.input_messages).toHaveLength(1);
    // output_message is wrapped when gen_ai_output_messages is absent.
    expect(response!.output_messages).toEqual([detail.output_message]);
    expect(response!.system_instructions).toEqual([
      { type: "text", content: "be nice" },
    ]);
    expect(response!.tool_definitions).toEqual([{ name: "lookup" }]);
  });

  it("retrieve() with an explicit itemId skips the scan and fetches that item", async () => {
    const detail = makeItem({
      id: "item-7",
      node_type: "assistant",
      response_id: "resp-7",
    });
    const http = mockHttp({ requestResult: detail });
    const api = new ConversationsApi(http);
    const response = await api.retrieve("conv-1", "item-7");

    expect(http.request).toHaveBeenCalledTimes(1);
    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/conversations/conv-1/items/item-7",
      query: {
        include: [
          "gen_ai.input.messages",
          "gen_ai.system_instructions",
          "gen_ai.tool.definitions",
        ],
      },
    });
    expect(response!.item_id).toBe("item-7");
    expect(response!.response_id).toBe("resp-7");
  });

  it("retrieve() falls back to the first item with an output_message", async () => {
    const listPage = makePage(
      [
        makeItem({ id: "item-2", node_type: "span" }),
        makeItem({
          id: "item-1",
          node_type: "span",
          output_message: { role: "assistant", parts: [] },
        }),
      ],
      false,
    );
    const http = mockHttp();
    (http.request as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(listPage)
      .mockResolvedValueOnce(
        makeItem({
          id: "item-1",
          output_message: { role: "assistant", parts: [] },
        }),
      );

    const api = new ConversationsApi(http);
    const response = await api.retrieve("conv-1");

    expect(response!.item_id).toBe("item-1");
  });

  it("retrieve() returns null when the conversation has no items", async () => {
    const http = mockHttp({ requestResult: makePage([], false) });
    const api = new ConversationsApi(http);
    const response = await api.retrieve("conv-1");

    expect(response).toBeNull();
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it("list() negotiates Arrow and rebuilds conversation summaries from the IPC stream + headers", async () => {
    const ipc = tableToIPC(
      tableFromArrays({
        trace_id: ["trace-1", "trace-2"],
        conversation_id: ["conv-1", "conv-2"],
        model: ["claude-x", "claude-y"],
      }),
      "stream",
    );
    const http = mockHttp({
      streamResult: new Response(ipc, {
        headers: {
          "x-result-count": "2",
          "x-truncated": "true",
          "x-next-cursor": "cursor-2",
          "x-total-count": "7",
        },
      }),
    });
    const api = new ConversationsApi(http);
    const page = await api.list({ format: "arrow", limit: 2 });

    expect(http.stream).toHaveBeenCalledWith({
      path: "/v1/conversations",
      query: { limit: 2 },
      headers: { Accept: "application/vnd.apache.arrow.stream" },
      signal: undefined,
    });
    expect(page.records).toEqual([
      { trace_id: "trace-1", conversation_id: "conv-1", model: "claude-x" },
      { trace_id: "trace-2", conversation_id: "conv-2", model: "claude-y" },
    ]);
    expect(page.count).toBe(2);
    expect(page.total_count).toBe(7);
    expect(page.next).toBe("cursor-2");
  });

  it("retrieve() maps legacy `result` keys on tool_call_response parts to `response`", async () => {
    const listPage = makePage(
      [makeItem({ id: "item-1", node_type: "assistant" })],
      false,
    );
    const detail = makeItem({
      id: "item-1",
      node_type: "assistant",
      input_messages: [
        {
          role: "tool",
          parts: [
            // Legacy DP shape: `result` instead of semconv `response`.
            {
              type: "tool_call_response",
              id: "call-1",
              result: { ok: true },
            } as never,
            { type: "text", content: "unrelated" },
          ],
        },
      ],
      gen_ai_output_messages: [
        {
          role: "assistant",
          parts: [
            {
              type: "tool_call_response",
              id: "call-2",
              response: "already-semconv",
            },
          ],
        },
      ],
    });
    const http = mockHttp();
    (http.request as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(listPage)
      .mockResolvedValueOnce(detail);

    const api = new ConversationsApi(http);
    const response = await api.retrieve("conv-1");

    expect(response!.input_messages[0].parts[0]).toEqual({
      type: "tool_call_response",
      id: "call-1",
      response: { ok: true },
    });
    // Non-tool parts and already-semconv parts pass through untouched.
    expect(response!.input_messages[0].parts[1]).toEqual({
      type: "text",
      content: "unrelated",
    });
    // gen_ai_output_messages is preferred over output_message.
    expect(response!.output_messages[0].parts[0]).toEqual({
      type: "tool_call_response",
      id: "call-2",
      response: "already-semconv",
    });
  });
});
