/**
 * Cookie-authenticated, read-only Conversations client for the browser
 * (`/v1/conversations`).
 *
 * Mirrors the Node SDK's runner-bound `ConversationsApi`, but rides the
 * DP `intro_dp_session` cookie via {@link BrowserHttpClient} instead of a
 * bearer token — so a single-page app reads conversation history with the
 * same identity session it uses for tasks and files. Conversations are a
 * projection over the immutable telemetry store: list summaries, walk a
 * conversation's items, or `retrieve()` the resolved state of one turn.
 */

import type {
  ConversationItem,
  ConversationItemInclude,
  ConversationItemList,
  ConversationItemListParams,
  ConversationListParams,
  ConversationResponse,
  ConversationSummary,
  MessagePart,
  Paginated,
  ToolCallResponsePart,
} from "@introspection-sdk/types";
import { Paginator, cursorPaginate } from "@introspection-sdk/http";
import { BrowserHttpClient } from "./http.js";

/** Includes requested when building a {@link ConversationResponse}. */
const RESPONSE_INCLUDES: ConversationItemInclude[] = [
  "gen_ai.input.messages",
  "gen_ai.system_instructions",
  "gen_ai.tool.definitions",
];

/**
 * Items of a conversation (`/v1/conversations/{id}/items`). Read-only.
 *
 * Paging is OpenAI-style underneath: the envelope has NO `next` token —
 * `list()` drives `after` = the previous page's `last_id` while
 * `has_more` is true.
 */
export class ConversationItemsClient {
  constructor(private readonly http: BrowserHttpClient) {}

  /**
   * List items of a conversation. `await` the result for the first page
   * (an OpenAI-style {@link ConversationItemList} envelope), or
   * `for await` it to stream every item across pages (fetched lazily —
   * `limit` sets the page size, `after` the starting cursor; stop early to
   * stop fetching). Pass `order: "asc"` to walk the transcript from the
   * start.
   *
   * Items carry the turn-local delta in `input_messages` — only the
   * messages new to that turn. Use `get()` for the full input history.
   */
  list(
    conversationId: string,
    params?: ConversationItemListParams,
  ): Paginator<ConversationItem, ConversationItemList> {
    return new Paginator(
      {
        fetch: (after) =>
          this.http.request<ConversationItemList>({
            method: "GET",
            path: `/v1/conversations/${encodeURIComponent(conversationId)}/items`,
            query: { ...params, after } as Record<string, unknown>,
          }),
        items: (page) => page.data,
        next: (page) =>
          page.has_more && page.last_id !== null ? page.last_id : undefined,
      },
      params?.after,
    );
  }

  /**
   * Fetch a single conversation item. Unlike the list route, the
   * detail's `input_messages` is the FULL input history for that span.
   */
  get(
    conversationId: string,
    itemId: string,
    params?: { include?: ConversationItemInclude[] },
  ): Promise<ConversationItem> {
    return this.http.request<ConversationItem>({
      method: "GET",
      path: `/v1/conversations/${encodeURIComponent(conversationId)}/items/${encodeURIComponent(itemId)}`,
      query: params as Record<string, unknown> | undefined,
    });
  }
}

/**
 * Read-only Conversations client (`/v1/conversations`).
 *
 * Both `list()` and `items.list()` are auto-paging, but they drive
 * different wire protocols underneath: `list()` walks the standard
 * Introspection cursor envelope's opaque `next` token, while
 * `items.list()` walks an OpenAI-style envelope via `after` = the
 * previous page's `last_id` while `has_more` is true.
 */
export class ConversationsClient {
  /** Items of a conversation — `conversations.items.list(...)` etc. */
  readonly items: ConversationItemsClient;

  constructor(private readonly http: BrowserHttpClient) {
    this.items = new ConversationItemsClient(http);
  }

  /**
   * List conversation summaries matching `params`. `await` the result for
   * the first page, or `for await` it to stream every summary across
   * pages (fetched lazily — `limit` sets the page size, `next` the
   * starting cursor; stop early to stop fetching).
   */
  list(params?: ConversationListParams): Paginator<ConversationSummary> {
    return cursorPaginate(
      (next) =>
        this.http.request<Paginated<ConversationSummary>>({
          method: "GET",
          path: "/v1/conversations",
          query: { ...params, next } as Record<string, unknown>,
        }),
      params?.next,
    );
  }

  /**
   * Responses-API-style retrieve: load the state of a conversation as of
   * one item — the full input history, output, system instructions, and
   * tool definitions of that turn.
   *
   * When `itemId` is omitted, the latest LLM turn is used: the first
   * item (in descending order) whose `node_type` is `"assistant"` or
   * whose `operation_name` is `"chat"`, falling back to the first item
   * with a non-null `output_message`. Returns `null` when the
   * conversation has no items.
   *
   * For the full per-turn transcript instead, iterate
   * `items.list(conversationId, { order: "asc" })`.
   */
  async retrieve(
    conversationId: string,
    itemId?: string,
  ): Promise<ConversationResponse | null> {
    const targetId = itemId ?? (await this.findLatestTurnId(conversationId));
    if (targetId === null) return null;

    const detail = await this.items.get(conversationId, targetId, {
      include: RESPONSE_INCLUDES,
    });
    const outputMessages =
      detail.gen_ai_output_messages ??
      (detail.output_message ? [detail.output_message] : []);
    return {
      conversation_id: conversationId,
      response_id: detail.response_id ?? null,
      item_id: detail.id,
      created_at: detail.created_at,
      model:
        detail.model_name ??
        detail.response_model ??
        detail.request_model ??
        null,
      provider_name: detail.provider_name ?? null,
      // The single-item route returns the FULL input history here.
      input_messages: normalizeMessages(detail.input_messages),
      output_messages: normalizeMessages(outputMessages),
      system_instructions: detail.system_instructions ?? null,
      tool_definitions: detail.tool_definitions ?? null,
    };
  }

  /** Scan items in descending order for the most recent LLM turn. */
  private async findLatestTurnId(
    conversationId: string,
  ): Promise<string | null> {
    let fallback: ConversationItem | null = null;
    for await (const item of this.items.list(conversationId, {
      order: "desc",
    })) {
      if (item.node_type === "assistant" || item.operation_name === "chat") {
        return item.id;
      }
      if (fallback === null && item.output_message != null) fallback = item;
    }
    return fallback?.id ?? null;
  }
}

/**
 * Defensive normalization for {@link ConversationsClient.retrieve} only:
 * older DP deployments emitted `tool_call_response` parts with a legacy
 * `result` key instead of the semconv `response` key. Map it across so
 * replayed history is always semconv-shaped.
 */
function normalizeMessages<T extends { parts: MessagePart[] }>(
  messages: T[],
): T[] {
  return messages.map((message) => ({
    ...message,
    parts: message.parts.map(normalizePart),
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
