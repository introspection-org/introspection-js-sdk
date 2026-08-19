import type {
  Conversation,
  ConversationExportParams,
  ConversationItemInclude,
  ConversationItemListParams,
  ConversationListParams,
  GenAiSpan,
  GenAiSpanList,
  MessagePart,
  ToolCallResponsePart,
  Trajectory,
} from "@introspection-sdk/types";
import { genAiOutputMessages } from "@introspection-sdk/types";
import { Paginator } from "../pagination.js";
import type { Table } from "apache-arrow";
import {
  ARROW_STREAM_MEDIA_TYPE,
  TRAJECTORY_MEDIA_TYPE,
  ArrowPages,
  arrowRead,
  listRead,
  loadArrow,
} from "./reads.js";
import type { ResourceHttpClient } from "./types.js";

export type ConversationExportFormat = "json" | "arrow" | "trajectory";

/**
 * Flatten the `conversation_metadata` dict into the repeated `?metadata=key:value`
 * params the API takes.
 *
 * The wire format is a repeated string param because a query string has no
 * native encoding for a map; the dict lives here so the ergonomics land in the
 * typed layer, where a key typo is a compile error rather than a filter that
 * silently returns the wrong page.
 */
function encodeListParams(
  params?: Omit<ConversationListParams, "format"> & {
    format?: "json" | "arrow";
  },
):
  | (Omit<ConversationListParams, "conversation_metadata"> & {
      metadata?: string[];
    })
  | undefined {
  if (!params) return undefined;
  const { conversation_metadata, ...rest } = params;
  if (!conversation_metadata) return rest;
  return {
    ...rest,
    metadata: Object.entries(conversation_metadata).map(
      ([key, value]) => `${key}:${value}`,
    ),
  };
}

/**
 * Items of a conversation (`/v1/conversations/{id}/items`). Read-only.
 *
 * The OpenAI-style envelope retains span-id metadata while `list()` drives
 * pagination with its opaque `next` token.
 */
export class ConversationItemsClient {
  constructor(private readonly http: ResourceHttpClient) {}

  /**
   * List items of a conversation. `await` the result for the first page
   * (an OpenAI-style {@link GenAiSpanList} envelope), or `for await` it to
   * stream every item across pages (fetched lazily — `limit` sets the page
   * size, `next` the starting cursor; stop early to stop fetching).
   *
   * Items are always returned newest-first: the route hardcodes a
   * descending sort and rejects a cursor that disagrees, so there is no
   * ordering parameter. Collect the pages and reverse to read forwards.
   *
   * Items carry the turn-local delta in `attributes.gen_ai.input.messages`
   * — only the messages new to that turn. Use `get()` for the full input
   * history.
   */
  list(
    conversationId: string,
    params?: ConversationItemListParams,
  ): Paginator<GenAiSpan, GenAiSpanList> {
    return new Paginator(
      {
        fetch: async (next) => {
          const page = await this.http.request<GenAiSpanList>({
            method: "GET",
            path: `/v1/conversations/${encodeURIComponent(conversationId)}/items`,
            query: { ...params, next } as Record<string, unknown>,
          });
          return { ...page, data: page.data.map(normalizeSpan) };
        },
        items: (page) => page.data,
        next: (page) => {
          if (page.has_more && !page.next) {
            throw new Error(
              `conversation items page for ${conversationId} has_more without next`,
            );
          }
          return page.next ?? undefined;
        },
      },
      params?.next,
    );
  }

  /**
   * Fetch a single conversation item. Unlike the list route, the detail's
   * `attributes.gen_ai.input.messages` is the FULL input history for that
   * span — unconditionally, with no `include` to remember.
   */
  async get(
    conversationId: string,
    itemId: string,
    params?: { include?: ConversationItemInclude[] },
  ): Promise<GenAiSpan> {
    const span = await this.http.request<GenAiSpan>({
      method: "GET",
      path: `/v1/conversations/${encodeURIComponent(conversationId)}/items/${encodeURIComponent(itemId)}`,
      query: params as Record<string, unknown> | undefined,
    });
    return normalizeSpan(span);
  }
}

/**
 * Read-only Conversations API (`/v1/conversations`).
 *
 * Summary reads return dedicated conversation resources; item reads return
 * GenAI spans.
 */
export class ConversationsClient {
  /** Items of a conversation — `conversations.items.list(...)` etc. */
  readonly items: ConversationItemsClient;

  constructor(private readonly http: ResourceHttpClient) {
    this.items = new ConversationItemsClient(http);
  }

  /**
   * List conversation summaries matching `params`. `await` the result for
   * the first page, or `for await` it to stream every summary across
   * pages (fetched lazily — `limit` sets the page size, `next` the
   * starting cursor; stop early to stop fetching).
   *
   * Accepts the ergonomic ordering/window params (`order`, `start`,
   * `end`, `lookback`) and an optional `format: "arrow"` that negotiates
   * an Apache Arrow IPC stream while exposing the identical page shape.
   * `lookback` is mutually exclusive with `start`/`end` and throws a
   * `ValidationError` before any request is sent.
   */
  list(params?: ConversationListParams): Paginator<Conversation> {
    return listRead<Conversation>(
      this.http,
      "/v1/conversations",
      encodeListParams(params),
    );
  }

  /** Fetch one conversation summary with its complete agent index. */
  get(conversationId: string): Promise<Conversation> {
    return this.http.request<Conversation>({
      method: "GET",
      path: `/v1/conversations/${encodeURIComponent(conversationId)}`,
    });
  }

  /**
   * Columnar read: async-iterate one Apache Arrow `Table` per page, or
   * call `.readAll()` to fetch and concatenate every page into a single
   * `Table`. Accepts the same params as {@link list} minus `format`
   * (Arrow is implied).
   *
   * Arrow exposes the same summary-resource fields in columnar form.
   *
   * Requires the optional `apache-arrow` peer dependency.
   */
  listArrow(params?: Omit<ConversationListParams, "format">): ArrowPages {
    return arrowRead(this.http, "/v1/conversations", encodeListParams(params));
  }

  /**
   * Export one complete conversation as the standard GenAI-span list.
   * The server owns its internal 1,000-row pagination.
   */
  async exportJson(
    conversationId: string,
    params?: ConversationExportParams,
  ): Promise<GenAiSpanList> {
    const result = await this.http.request<GenAiSpanList>({
      method: "GET",
      path: `/v1/conversations/${encodeURIComponent(conversationId)}/export`,
      query: params as Record<string, unknown> | undefined,
      headers: { Accept: "application/json" },
    });
    return { ...result, data: result.data.map(normalizeSpan) };
  }

  /**
   * Return the raw complete-export byte stream without buffering it in the SDK.
   * Use this for direct file writes or custom incremental decoders.
   */
  exportStream(
    conversationId: string,
    format: ConversationExportFormat,
    params?: ConversationExportParams,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    const accept =
      format === "arrow"
        ? ARROW_STREAM_MEDIA_TYPE
        : format === "trajectory"
          ? `${TRAJECTORY_MEDIA_TYPE};version=1`
          : "application/json";
    return this.http.request<ReadableStream<Uint8Array>>({
      method: "GET",
      path: `/v1/conversations/${encodeURIComponent(conversationId)}/export`,
      query: params as Record<string, unknown> | undefined,
      headers: { Accept: accept },
      expect: "stream",
      signal,
    });
  }

  /**
   * Export one complete conversation as trajectory-v1: a non-empty array
   * of `meta` / `user` / `reasoning` / `assistant` / `tool` records.
   *
   * The server streams its internal pages into one response; this convenience
   * method parses that response into a complete typed array. Use
   * {@link exportStream} to consume raw bytes incrementally.
   *
   * The trajectory is a projection derived on read from the stored GenAI
   * messages, so a conversation that cannot be represented as trajectory-v1
   * fails with a `ValidationError` rather than returning a partial export.
   * A conversation with no exportable records is a `NotFoundError`.
   */
  async exportTrajectory(
    conversationId: string,
    params?: ConversationExportParams,
  ): Promise<Trajectory> {
    return this.http.request<Trajectory>({
      method: "GET",
      path: `/v1/conversations/${encodeURIComponent(conversationId)}/export`,
      query: params as Record<string, unknown> | undefined,
      headers: { Accept: `${TRAJECTORY_MEDIA_TYPE};version=1` },
    });
  }

  /**
   * Export one complete conversation as a single Apache Arrow `Table`.
   *
   * Unlike {@link listArrow}, this returns one table for the whole conversation.
   * Use {@link exportStream} to avoid buffering the Arrow response in the SDK.
   *
   * Requires the optional `apache-arrow` peer dependency.
   */
  async exportArrow(
    conversationId: string,
    params?: ConversationExportParams,
  ): Promise<Table> {
    const res = await this.http.stream({
      path: `/v1/conversations/${encodeURIComponent(conversationId)}/export`,
      query: params as Record<string, unknown> | undefined,
      headers: { Accept: ARROW_STREAM_MEDIA_TYPE },
    });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const arrow = await loadArrow();
    if (bytes.byteLength === 0) return new arrow.Table();
    return arrow.tableFromIPC(bytes);
  }

  /**
   * Load the state of a conversation as of one item — the full input
   * history, output, system instructions, and tool definitions of that
   * turn.
   *
   * Returns the span itself. There is no separate response type any more:
   * the item detail read already carries all of that under its semconv
   * attribute names, so composing a second object from it would just be
   * copying fields into different names.
   *
   * When `itemId` is omitted, the latest LLM turn is used: the first item
   * (in descending order) whose `gen_ai.operation.name` is `"chat"`,
   * falling back to the first item that produced any output. Returns
   * `null` when the conversation has no items.
   *
   * For the full per-turn transcript instead, iterate
   * `items.list(conversationId)`, which is newest-first.
   */
  async retrieve(
    conversationId: string,
    itemId?: string,
  ): Promise<GenAiSpan | null> {
    const targetId = itemId ?? (await this.findLatestTurnId(conversationId));
    if (targetId === null) return null;
    return this.items.get(conversationId, targetId);
  }

  /**
   * Scan items in descending order for the most recent LLM turn.
   *
   * The old heuristic also matched `node_type === "assistant"`, but
   * `node_type` was a precomputed UI tree hint with no semantic-convention
   * equivalent and is gone from the wire. `gen_ai.operation.name` is the
   * attribute that actually carried the meaning.
   */
  private async findLatestTurnId(
    conversationId: string,
  ): Promise<string | null> {
    let fallback: GenAiSpan | null = null;
    // The route is descending-only, so the first matching item is the latest.
    for await (const item of this.items.list(conversationId)) {
      if (item.attributes.gen_ai?.operation?.name === "chat") {
        return item.span_id ?? null;
      }
      if (fallback === null && genAiOutputMessages(item).length > 0) {
        fallback = item;
      }
    }
    return fallback?.span_id ?? null;
  }
}

/**
 * Defensive normalization: older DP deployments emitted
 * `tool_call_response` parts with a legacy `result` key instead of the
 * semconv `response` key. Map it across so replayed history is always
 * semconv-shaped.
 *
 * The mapping itself is unchanged and still needed — it is a compatibility
 * shim for older DP deployments, not an artifact of the old envelope. What
 * changed is where the messages live: they used to be flat top-level
 * fields, and now they sit under `attributes.gen_ai.{input,output}.messages`,
 * so the walk follows the tree.
 */
function normalizeSpan(span: GenAiSpan): GenAiSpan {
  const genAi = span.attributes?.gen_ai;
  if (!genAi) return span;

  const input = genAi.input?.messages;
  const output = genAi.output?.messages;
  if (!input && !output) return span;

  return {
    ...span,
    attributes: {
      ...span.attributes,
      gen_ai: {
        ...genAi,
        ...(input
          ? { input: { ...genAi.input, messages: normalizeMessages(input) } }
          : {}),
        ...(output
          ? { output: { ...genAi.output, messages: normalizeMessages(output) } }
          : {}),
      },
    },
  };
}

function normalizeMessages<T extends { parts: MessagePart[] }>(
  messages: T[],
): T[] {
  return messages.map((message) => ({
    ...message,
    parts: (message.parts ?? []).map(normalizePart),
  }));
}

function normalizePart(part: MessagePart): MessagePart {
  if (part.type !== "tool_call_response") return part;
  const legacy = part as ToolCallResponsePart & { result?: unknown };
  if (legacy.response !== undefined || legacy.result === undefined) {
    return part;
  }
  const { result, ...rest } = legacy;
  return { ...rest, response: result };
}

export {
  ConversationsClient as ConversationsApi,
  ConversationItemsClient as ConversationItemsApi,
};
