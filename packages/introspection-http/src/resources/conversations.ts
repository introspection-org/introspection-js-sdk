import type {
  Conversation,
  ConversationExportParams,
  ConversationExportResumeParams,
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
import { readJsonLines } from "./json-lines.js";
import { encodeMetadataFilter } from "./metadata-filter.js";
import type { ResourceHttpClient } from "./types.js";

/**
 * A representation of the conversation export. `"jsonl"` is the span export:
 * JSON lines (`application/x-ndjson`), one GenAI span per line, each line a
 * complete JSON object, so it can be read as it streams. The JSON-envelope
 * export, one document holding every span, was removed.
 */
export type ConversationExportFormat = "jsonl" | "arrow" | "trajectory";

const EXPORT_ACCEPT: Record<ConversationExportFormat, string> = {
  jsonl: "application/x-ndjson",
  arrow: ARROW_STREAM_MEDIA_TYPE,
  trajectory: `${TRAJECTORY_MEDIA_TYPE};version=1`,
};

/**
 * The response header naming the cursor an export resumes from: the shared
 * "cursor to pass as `next`" header the Arrow list responses also carry.
 */
const EXPORT_NEXT_HEADER = "X-Next-Cursor";

/**
 * One export from {@link ConversationsClient.exportIncremental}, with the
 * cursor to resume from. Discriminated by `status`:
 *
 * - `"ok"` — `body` is the raw export byte stream. `next` is the cursor to
 *   pass as `next` on the following export, or `null` when the response
 *   named none (a newest-first export).
 * - `"no_newer"` — the export was resumed with `next` and nothing is newer
 *   (`204 No Content`). There is no body; `next` is the cursor to retry with.
 *
 * `next` is opaque and embeds a nanosecond timestamp: keep it as a string.
 */
export type ConversationExportResult =
  | {
      status: "ok";
      body: ReadableStream<Uint8Array>;
      next: string | null;
    }
  | { status: "no_newer"; body: null; next: string };

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
   * Items are returned newest-first unless `direction: "asc"` asks for
   * oldest-first from the conversation start. Every page is requested with
   * the same `direction`, which an `"asc"` cursor requires.
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
            schema: "GenAiSpanList",
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
      schema: "GenAiSpan",
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
    const query = encodeMetadataFilter(params);
    return listRead<Conversation>(
      this.http,
      "/v1/conversations",
      query,
      "Paginated<Conversation>",
    );
  }

  /** Fetch one conversation summary with its complete agent index. */
  get(conversationId: string): Promise<Conversation> {
    return this.http.request<Conversation>({
      method: "GET",
      path: `/v1/conversations/${encodeURIComponent(conversationId)}`,
      schema: "Conversation",
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
    return arrowRead(
      this.http,
      "/v1/conversations",
      encodeMetadataFilter(params),
    );
  }

  /**
   * Export one complete conversation's GenAI spans. The response is JSON
   * lines (`application/x-ndjson`): one span per line, each line a complete
   * JSON object. Each is parsed and yielded as it arrives, so the export is
   * never buffered whole. The server owns its internal pagination.
   *
   * This replaces the removed JSON-envelope export; collect the spans into an
   * array if the whole list is needed.
   */
  async *exportJsonl(
    conversationId: string,
    params?: ConversationExportParams,
    signal?: AbortSignal,
  ): AsyncGenerator<GenAiSpan> {
    const body = await this.exportStream(
      conversationId,
      "jsonl",
      params,
      signal,
    );
    for await (const span of readJsonLines<GenAiSpan>(body)) {
      yield normalizeSpan(span);
    }
  }

  /**
   * Return the raw complete-export byte stream without buffering it in the SDK.
   * Use this for direct file writes or custom incremental decoders. With
   * `"jsonl"` the bytes are JSON lines (`application/x-ndjson`): one GenAI
   * span per line, each line a complete JSON object.
   */
  exportStream(
    conversationId: string,
    format: ConversationExportFormat,
    params?: ConversationExportParams,
    signal?: AbortSignal,
  ): Promise<ReadableStream<Uint8Array>> {
    return this.http.request<ReadableStream<Uint8Array>>({
      method: "GET",
      path: `/v1/conversations/${encodeURIComponent(conversationId)}/export`,
      query: params as Record<string, unknown> | undefined,
      headers: { Accept: EXPORT_ACCEPT[format] },
      expect: "stream",
      signal,
    });
  }

  /**
   * Export a conversation oldest-first and return the cursor to resume
   * from, so a follower can export only what is newer each time.
   *
   * Without `next` this exports from the conversation start (pass
   * `direction: "asc"` for a span export, whose default is newest-first);
   * with `next` it exports what came after that cursor, up to the latest
   * item that existed when the request began. The cursor arrives in the
   * `X-Next-Cursor` response header, before the body streams, and is
   * returned beside the raw byte stream. When nothing is newer than `next`
   * the result is `status: "no_newer"` with the same cursor, not an error.
   *
   * ```ts
   * let next: string | undefined;
   * const page = await client.conversations.exportIncremental(id, "jsonl", {
   *   direction: "asc",
   *   next,
   * });
   * if (page.status === "ok") await save(page.body);
   * next = page.next ?? next;
   * ```
   */
  async exportIncremental(
    conversationId: string,
    format: ConversationExportFormat,
    params?: ConversationExportResumeParams,
    signal?: AbortSignal,
  ): Promise<ConversationExportResult> {
    const res = await this.http.stream({
      path: `/v1/conversations/${encodeURIComponent(conversationId)}/export`,
      query: params as Record<string, unknown> | undefined,
      headers: { Accept: EXPORT_ACCEPT[format] },
      signal,
    });
    const next = res.headers.get(EXPORT_NEXT_HEADER);
    if (res.status === 204) {
      // The server echoes the cursor; fall back to the one sent if it didn't.
      const cursor = next ?? params?.next;
      if (cursor === undefined) {
        throw new Error(
          `conversation export for ${conversationId} answered 204 without ${EXPORT_NEXT_HEADER}`,
        );
      }
      return { status: "no_newer", body: null, next: cursor };
    }
    return {
      status: "ok",
      body:
        res.body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      next,
    };
  }

  /**
   * Export one complete conversation as trajectory-v1: a non-empty array
   * of `meta` / `user` / `reasoning` / `assistant` / `tool` records.
   *
   * The server streams its internal pages into one response; this convenience
   * method parses that response into a complete typed array. Use
   * {@link exportStream} to consume raw bytes incrementally, and
   * {@link exportJsonl} for the GenAI spans themselves.
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
      schema: "Trajectory",
      query: params as Record<string, unknown> | undefined,
      headers: { Accept: `${TRAJECTORY_MEDIA_TYPE};version=1` },
    });
  }

  /**
   * Export one complete conversation as a single Apache Arrow `Table`.
   *
   * Unlike {@link listArrow}, this returns one table for the whole conversation.
   * For the spans as JSON lines use {@link exportJsonl}.
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
    // The list is newest-first by default, so the first match is the latest.
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

function normalizeMessages<T extends { parts?: MessagePart[] }>(
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
