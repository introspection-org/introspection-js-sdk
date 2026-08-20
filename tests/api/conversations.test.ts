import { describe, expect, it, vi } from "vitest";
import * as arrow from "apache-arrow";
import {
  ConversationsApi,
  HttpClient,
} from "@introspection-sdk/introspection-node";
import type {
  Conversation,
  GenAiSpan,
  GenAiSpanList,
  Trajectory,
} from "@introspection-sdk/introspection-node";
import { bytesBody } from "../testing";

function mockHttp(overrides: Record<string, unknown> = {}) {
  return {
    request: vi.fn().mockResolvedValue(overrides.requestResult ?? {}),
    stream: vi.fn().mockResolvedValue(overrides.streamResult ?? new Response()),
  } as unknown as HttpClient;
}

const SUMMARY_FIXTURE: Conversation = {
  object: "conversation",
  id: "conv-1",
  task_title: "Map Australian fintech leaders",
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:05Z",
  usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  cost: { usd: 0.01 },
  metrics: {
    duration_ms: 5_000,
    trace_count: 1,
    span_count: 3,
    tool_use_count: 0,
    failed_tool_use_count: 0,
    has_errors: false,
  },
  service_name: "coding-agent",
};

function makeSpan(
  spanId: string,
  attributes: GenAiSpan["attributes"] = {},
): GenAiSpan {
  return {
    trace_id: "trace-1",
    span_id: spanId,
    start_time: "2025-01-01T00:00:00Z",
    name: "chat anthropic",
    kind: "CLIENT",
    attributes,
  };
}

function makePage(data: GenAiSpan[], has_more: boolean): GenAiSpanList {
  return {
    object: "list",
    data,
    first_id: data[0]?.span_id ?? null,
    last_id: data[data.length - 1]?.span_id ?? null,
    has_more,
    next: has_more ? "cursor-page-2" : null,
  };
}

/** A `chat` turn with an output message — what `retrieve()` scans for. */
function makeChatSpan(spanId: string): GenAiSpan {
  return makeSpan(spanId, {
    gen_ai: {
      operation: { name: "chat" },
      provider: { name: "anthropic" },
      request: { model: "claude-x" },
      response: { id: `resp-${spanId}`, model: "claude-x" },
      input: {
        messages: [{ role: "user", parts: [{ type: "text", content: "hi" }] }],
      },
      output: {
        messages: [
          {
            role: "assistant",
            parts: [{ type: "text", content: "hello" }],
            finish_reason: "stop",
          },
        ],
      },
      system_instructions: [{ type: "text", content: "be nice" }],
      tool: { definitions: [{ type: "function", name: "lookup" }] },
    },
  });
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
    expect(summaries[0].id).toBe("conv-1");
    expect(summaries[0].task_title).toBe("Map Australian fintech leaders");
    expect(summaries[0].metrics.span_count).toBe(3);
  });

  it("list() drives the cursor `next` token until exhausted", async () => {
    const page1 = {
      records: [SUMMARY_FIXTURE],
      count: 1,
      total_count: 2,
      next: "cursor-2",
    };
    const page2 = {
      records: [{ ...SUMMARY_FIXTURE, id: "conv-2" }],
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
    expect(summaries[1].id).toBe("conv-2");
    expect(http.request).toHaveBeenCalledTimes(2);
    expect(
      (http.request as ReturnType<typeof vi.fn>).mock.calls[1][0].query.next,
    ).toBe("cursor-2");
  });

  it("list() flattens metadata into repeated key:value params", async () => {
    const http = mockHttp({
      requestResult: {
        records: [SUMMARY_FIXTURE],
        count: 1,
        total_count: 1,
        next: null,
      },
    });
    const api = new ConversationsApi(http);
    for await (const _ of api.list({
      metadata: { flow: "company", tenant: "acme" },
    }));

    // A query string cannot carry a map, so the dict becomes the repeated
    // `?metadata=key:value` param the API takes. `buildQuery` expands the
    // array into repeated keys.
    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/conversations",
      query: { metadata: ["flow:company", "tenant:acme"] },
    });
  });

  it("list() omits metadata entirely when no dimensions were asked for", async () => {
    const http = mockHttp({
      requestResult: {
        records: [SUMMARY_FIXTURE],
        count: 1,
        total_count: 1,
        next: null,
      },
    });
    const api = new ConversationsApi(http);
    for await (const _ of api.list({ limit: 5 }));

    const query = (http.request as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .query;
    expect(query).not.toHaveProperty("metadata");
  });

  it("get() returns the complete structural agent index", async () => {
    const http = mockHttp({
      requestResult: {
        ...SUMMARY_FIXTURE,
        agents: [{ id: "agent-root", name: "coordinator", depth: 0 }],
      },
    });
    const api = new ConversationsApi(http);

    const conversation = await api.get("conv-1");

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/conversations/conv-1",
    });
    expect(conversation.agents?.[0]?.id).toBe("agent-root");
  });

  it("items.list() calls GET /v1/conversations/:id/items with the surviving includes", async () => {
    const http = mockHttp({
      requestResult: makePage([makeSpan("span-1")], false),
    });
    const api = new ConversationsApi(http);
    const items = [];
    for await (const item of api.items.list("conv-1", {
      include: ["events", "resource_attributes"],
    })) {
      items.push(item);
    }

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/conversations/conv-1/items",
      // No ordering parameter: the route sorts descending and takes none.
      query: { include: ["events", "resource_attributes"] },
    });
    expect(items).toHaveLength(1);
  });

  it("items.list() drives the opaque next cursor while has_more, then stops", async () => {
    const page1 = makePage([makeSpan("span-1"), makeSpan("span-2")], true);
    const page2 = makePage([makeSpan("span-3")], false);
    const http = mockHttp();
    (http.request as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);

    const api = new ConversationsApi(http);
    const items = [];
    for await (const item of api.items.list("conv-1")) items.push(item);

    expect(items.map((i) => i.span_id)).toEqual(["span-1", "span-2", "span-3"]);
    expect(http.request).toHaveBeenCalledTimes(2);
    const calls = (http.request as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[0][0].query.next).toBeUndefined();
    expect(calls[1][0].query.next).toBe("cursor-page-2");
  });

  it("items.list() terminates on an empty page (has_more=false, next=null)", async () => {
    const http = mockHttp({ requestResult: makePage([], false) });
    const api = new ConversationsApi(http);
    const items = [];
    for await (const item of api.items.list("conv-1")) items.push(item);

    expect(items).toHaveLength(0);
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it("items.list() rejects has_more without an opaque next cursor", async () => {
    const page = makePage([makeSpan("span-1")], true);
    page.next = null;
    const http = mockHttp({ requestResult: page });
    const api = new ConversationsApi(http);

    const consume = async () => {
      for await (const _item of api.items.list("conv-1")) {
        // Consume the iterator so it evaluates the continuation contract.
      }
    };
    await expect(consume()).rejects.toThrow("has_more without next");
  });

  it("items.list() walks every page without an order param", async () => {
    const page1 = makePage([makeSpan("span-1")], true);
    const page2 = makePage([makeSpan("span-2")], false);
    const http = mockHttp();
    (http.request as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);

    const api = new ConversationsApi(http);
    const items = [];
    for await (const item of api.items.list("conv-1")) {
      items.push(item);
    }

    expect(items.map((i) => i.span_id)).toEqual(["span-1", "span-2"]);
    const calls = (http.request as ReturnType<typeof vi.fn>).mock.calls;
    // It used to send `order`, which the route silently dropped: a caller
    // asking for "asc" got descending items and no error.
    expect(calls[0][0].query.order).toBeUndefined();
    expect(calls[1][0].query.order).toBeUndefined();
  });

  it("items.get() URL-encodes path segments", async () => {
    const http = mockHttp({ requestResult: makeSpan("span-1") });
    const api = new ConversationsApi(http);
    await api.items.get("conv/with spaces", "span:1", { include: ["events"] });

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/conversations/conv%2Fwith%20spaces/items/span%3A1",
      query: { include: ["events"] },
    });
  });

  it("retrieve() picks the latest chat turn and returns the span itself", async () => {
    // Descending order: an execute_tool span first, then the chat turn.
    const listPage = makePage(
      [
        makeSpan("span-3", { gen_ai: { operation: { name: "execute_tool" } } }),
        makeChatSpan("span-2"),
        makeSpan("span-1"),
      ],
      false,
    );
    const detail = makeChatSpan("span-2");
    const http = mockHttp();
    (http.request as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(listPage)
      .mockResolvedValueOnce(detail);

    const api = new ConversationsApi(http);
    const span = await api.retrieve("conv-1");

    const calls = (http.request as ReturnType<typeof vi.fn>).mock.calls;
    // No ordering parameter is sent: the route is descending-only.
    expect(calls[0][0].query.order).toBeUndefined();
    // No `include` to remember: the detail read returns the full history
    // unconditionally. A parameter that is always required is a trap.
    expect(calls[1][0]).toEqual({
      method: "GET",
      path: "/v1/conversations/conv-1/items/span-2",
      query: undefined,
    });
    expect(span).not.toBeNull();
    expect(span!.span_id).toBe("span-2");
    expect(span!.attributes.gen_ai?.response?.id).toBe("resp-span-2");
    expect(span!.attributes.gen_ai?.request?.model).toBe("claude-x");
    expect(span!.attributes.gen_ai?.provider?.name).toBe("anthropic");
    expect(span!.attributes.gen_ai?.input?.messages).toHaveLength(1);
    expect(span!.attributes.gen_ai?.output?.messages).toHaveLength(1);
    expect(span!.attributes.gen_ai?.system_instructions).toEqual([
      { type: "text", content: "be nice" },
    ]);
    expect(span!.attributes.gen_ai?.tool?.definitions).toEqual([
      { type: "function", name: "lookup" },
    ]);
  });

  it("retrieve() with an explicit itemId skips the scan and fetches that item", async () => {
    const detail = makeChatSpan("span-7");
    const http = mockHttp({ requestResult: detail });
    const api = new ConversationsApi(http);
    const span = await api.retrieve("conv-1", "span-7");

    expect(http.request).toHaveBeenCalledTimes(1);
    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/conversations/conv-1/items/span-7",
      query: undefined,
    });
    expect(span!.span_id).toBe("span-7");
    expect(span!.attributes.gen_ai?.response?.id).toBe("resp-span-7");
  });

  it("retrieve() falls back to the first item that produced output", async () => {
    const listPage = makePage(
      [
        makeSpan("span-2"),
        makeSpan("span-1", {
          gen_ai: { output: { messages: [{ role: "assistant", parts: [] }] } },
        }),
      ],
      false,
    );
    const http = mockHttp();
    (http.request as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(listPage)
      .mockResolvedValueOnce(makeSpan("span-1"));

    const api = new ConversationsApi(http);
    const span = await api.retrieve("conv-1");

    expect(span!.span_id).toBe("span-1");
  });

  it("retrieve() returns null when the conversation has no items", async () => {
    const http = mockHttp({ requestResult: makePage([], false) });
    const api = new ConversationsApi(http);
    const span = await api.retrieve("conv-1");

    expect(span).toBeNull();
    expect(http.request).toHaveBeenCalledTimes(1);
  });

  it("maps legacy `result` keys on tool_call_response parts to `response`", async () => {
    // Compatibility shim for older DP deployments — unchanged in substance,
    // but the walk now follows the attribute tree instead of flat fields.
    const detail = makeSpan("span-1", {
      gen_ai: {
        input: {
          messages: [
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
        },
        output: {
          messages: [
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
        },
      },
    });
    const http = mockHttp({ requestResult: detail });
    const api = new ConversationsApi(http);

    const span = await api.retrieve("conv-1", "span-1");

    expect(span!.attributes.gen_ai?.input?.messages?.[0].parts[0]).toEqual({
      type: "tool_call_response",
      id: "call-1",
      response: { ok: true },
    });
    // Non-tool parts and already-semconv parts pass through untouched.
    expect(span!.attributes.gen_ai?.input?.messages?.[0].parts[1]).toEqual({
      type: "text",
      content: "unrelated",
    });
    expect(span!.attributes.gen_ai?.output?.messages?.[0].parts[0]).toEqual({
      type: "tool_call_response",
      id: "call-2",
      response: "already-semconv",
    });
  });

  it("preserves undeclared attributes through the client", () => {
    // The client must not narrow what the server returns: an attribute nobody
    // modelled has to survive the trip through `items.list()` normalization.
    const span = makeSpan("span-1", {
      gen_ai: {
        input: {
          messages: [
            { role: "user", parts: [{ type: "text", content: "hi" }] },
          ],
        },
        vendor_specific: "kept",
      },
      acme: { tenant: "x" },
    });
    const http = mockHttp({ requestResult: makePage([span], false) });
    const api = new ConversationsApi(http);

    return (async () => {
      const items = [];
      for await (const item of api.items.list("conv-1")) items.push(item);

      expect(items[0].attributes.gen_ai?.vendor_specific).toBe("kept");
      expect(items[0].attributes.acme).toEqual({ tenant: "x" });
    })();
  });
});

describe("ConversationsApi.list — Arrow format", () => {
  it("negotiates Arrow and rebuilds conversation summaries from the IPC stream + headers", async () => {
    // Arrow exposes the summary resource in columnar form.
    // every aggregable field collapses into one JSON column.
    const ipc = arrow.tableToIPC(
      arrow.tableFromArrays({
        trace_id: ["trace-1", "trace-2"],
        conversation_id: ["conv-1", "conv-2"],
        task_title: ["Map Australian fintech leaders", null],
        model: ["claude-x", "claude-y"],
      }),
      "stream",
    );
    const http = mockHttp({
      streamResult: new Response(bytesBody(ipc), {
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
      {
        trace_id: "trace-1",
        conversation_id: "conv-1",
        task_title: "Map Australian fintech leaders",
        model: "claude-x",
      },
      {
        trace_id: "trace-2",
        conversation_id: "conv-2",
        task_title: null,
        model: "claude-y",
      },
    ]);
    expect(page.count).toBe(2);
    expect(page.total_count).toBe(7);
    expect(page.next).toBe("cursor-2");
  });

  it("decodes an empty Arrow page (zero-byte body) to zero records without touching Arrow", async () => {
    // A zero-byte body must skip the `apache-arrow` decode entirely
    // (the `bytes.byteLength > 0` guard in reads.ts) and still yield a
    // sane, exhausted Paginated envelope from the headers alone.
    const http = mockHttp({
      streamResult: new Response(new Uint8Array(0), {
        headers: { "x-result-count": "0", "x-truncated": "false" },
      }),
    });
    const api = new ConversationsApi(http);
    const page = await api.list({ format: "arrow" });

    expect(page.records).toEqual([]);
    expect(page.count).toBe(0);
    expect(page.total_count).toBeNull();
    expect(page.next).toBeNull();
  });
});

describe("ConversationsApi.arrow — columnar accessor", () => {
  it("yields Tables over /v1/conversations and readAll() concatenates", async () => {
    const makeIpc = (ids: string[]) =>
      bytesBody(
        arrow.tableToIPC(
          new arrow.Table({
            conversation_id: arrow.vectorFromArray(ids, new arrow.Utf8()),
          }),
          "stream",
        ),
      );
    const page1 = new Response(makeIpc(["c-1", "c-2"]), {
      headers: { "x-next-cursor": "cursor-2" },
    });
    const page2 = new Response(makeIpc(["c-3"]), { headers: {} });
    const http = mockHttp();
    (http.stream as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);
    const api = new ConversationsApi(http);

    const tables: arrow.Table[] = [];
    for await (const table of api.listArrow()) tables.push(table);
    expect(tables).toHaveLength(2);
    expect(tables[0]).toBeInstanceOf(arrow.Table);
    expect(tables[0].numRows).toBe(2);
    expect(tables[1].numRows).toBe(1);

    (http.stream as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        new Response(makeIpc(["c-1", "c-2"]), {
          headers: { "x-next-cursor": "cursor-2" },
        }),
      )
      .mockResolvedValueOnce(new Response(makeIpc(["c-3"]), { headers: {} }));
    const table = await api.listArrow().readAll();

    expect(http.stream).toHaveBeenCalledWith({
      path: "/v1/conversations",
      query: {},
      headers: { Accept: "application/vnd.apache.arrow.stream" },
      signal: undefined,
    });
    expect(table.numRows).toBe(3);
    expect(table.getChild("conversation_id")?.get(0)).toBe("c-1");
  });
});

describe("conversations export", () => {
  const TRAJECTORY: Trajectory = [
    { role: "meta", source: "claude-code", model: "opus" },
    { role: "user", content: "fix the bug", timestamp: "2025-01-01T00:00:00Z" },
    {
      role: "assistant",
      content: null,
      timestamp: "2025-01-01T00:00:01Z",
      tool_calls: [{ id: "call_1", name: "edit", args: '{"path":"a.py"}' }],
    },
    {
      role: "tool",
      tool_call_id: "call_1",
      content: "ok",
      timestamp: "2025-01-01T00:00:02Z",
      ok: true,
    },
    { role: "assistant", content: "done", timestamp: "2025-01-01T00:00:03Z" },
  ];

  it("requests the server-owned complete JSON export", async () => {
    const page = makePage([makeSpan("span-1")], false);
    const http = mockHttp({ requestResult: page });

    const result = await new ConversationsApi(http).exportJson("conv/1", {
      agent: "root",
    });

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/conversations/conv%2F1/export",
      query: { agent: "root" },
      headers: { Accept: "application/json" },
    });
    expect(result.data).toHaveLength(1);
  });

  it.each([
    ["json", "application/json"],
    ["arrow", "application/vnd.apache.arrow.stream"],
    ["trajectory", "application/vnd.letta.trajectory+json;version=1"],
  ] as const)("returns the raw %s export stream", async (format, accept) => {
    const stream = new ReadableStream<Uint8Array>();
    const http = mockHttp({ requestResult: stream });

    const result = await new ConversationsApi(http).exportStream(
      "conv-1",
      format,
    );

    expect(result).toBe(stream);
    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/conversations/conv-1/export",
      query: undefined,
      headers: { Accept: accept },
      expect: "stream",
      signal: undefined,
    });
  });

  it("negotiates trajectory v1 and returns the typed record array", async () => {
    const http = mockHttp({ requestResult: TRAJECTORY });
    const api = new ConversationsApi(http);

    const records = await api.exportTrajectory("conv-1");

    const call = (http.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.path).toBe("/v1/conversations/conv-1/export");
    // The version parameter is load-bearing: without it a server serving a
    // different trajectory version would be indistinguishable from v1.
    expect(call.headers.Accept).toBe(
      "application/vnd.letta.trajectory+json;version=1",
    );

    expect(records.map((r) => r.role)).toEqual([
      "meta",
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    const toolCall = records[2];
    if (toolCall.role !== "assistant") throw new Error("expected assistant");
    // `content: null` is what distinguishes a tool-call record from prose.
    expect(toolCall.content).toBeNull();
    expect(toolCall.tool_calls?.[0].args).toBe('{"path":"a.py"}');
  });

  it("sends filters and never a cursor or page bound", async () => {
    const http = mockHttp({ requestResult: TRAJECTORY });
    await new ConversationsApi(http).exportTrajectory("conv-1", {
      agent: "root",
      service_name: "svc",
      lookback_days: 7,
    });

    const call = (http.request as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.query).toEqual({
      agent: "root",
      service_name: "svc",
      lookback_days: 7,
    });
    // The server owns pagination; callers never send export cursors.
    expect(call.query).not.toHaveProperty("limit");
    expect(call.query).not.toHaveProperty("next");
  });

  it("returns one Arrow table for the whole conversation", async () => {
    const table = arrow.tableFromArrays({
      id: ["a", "b"],
      content: ["hi", "there"],
    });
    const bytes = arrow.tableToIPC(table, "stream");
    const http = mockHttp({
      streamResult: new Response(bytes as unknown as BodyInit),
    });

    const result = await new ConversationsApi(http).exportArrow("conv-1");

    const call = (http.stream as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.headers.Accept).toBe("application/vnd.apache.arrow.stream");
    expect(result.numRows).toBe(2);
  });

  it("returns an empty table for an empty export body", async () => {
    const http = mockHttp({ streamResult: new Response(new Uint8Array()) });
    const result = await new ConversationsApi(http).exportArrow("conv-1");
    expect(result.numRows).toBe(0);
  });
});
