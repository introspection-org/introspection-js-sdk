import type {
  ConversationItem,
  ConversationItemInclude,
  ConversationItemList,
  ConversationItemListParams,
  ConversationListParams,
  ConversationState,
  ConversationSummary,
  MessagePart,
  Paginated,
  ToolCallResponsePart,
} from "@introspection-sdk/types";
import { HttpClient } from "../http.js";

/** Includes requested when building a {@link ConversationState}. */
const STATE_INCLUDES: ConversationItemInclude[] = [
  "gen_ai.input.messages",
  "gen_ai.system_instructions",
  "gen_ai.tool.definitions",
];

/** Full transcript returned by {@link ConversationsApi.retrieve}. */
export interface ConversationTranscript {
  conversation_id: string;
  /** All items in ascending order; each carries its per-turn input delta. */
  items: ConversationItem[];
}

/**
 * Read-only Conversations API (`/v1/conversations`).
 *
 * Two paging styles are in play:
 * - `list()` uses the standard Introspection cursor envelope — drive the
 *   opaque `next` token (see `listAll()`).
 * - `listItems()` uses an OpenAI-style envelope with NO `next` token —
 *   drive `after` = the previous page's `last_id` while `has_more` is
 *   true (see `listItemsAll()`).
 */
export class ConversationsApi {
  constructor(private readonly http: HttpClient) {}

  /** List conversation summaries (cursor-paged Introspection envelope). */
  list(
    params?: ConversationListParams,
  ): Promise<Paginated<ConversationSummary>> {
    return this.http.request<Paginated<ConversationSummary>>({
      method: "GET",
      path: "/v1/conversations",
      query: params as Record<string, unknown> | undefined,
    });
  }

  /** Iterate all conversation summaries, driving the `next` token. */
  async *listAll(
    params?: ConversationListParams,
  ): AsyncIterable<ConversationSummary> {
    let next: string | undefined = params?.next;
    do {
      const page = await this.list({ ...params, next });
      for (const c of page.records) yield c;
      next = page.next ?? undefined;
    } while (next);
  }

  /**
   * List items of a conversation (OpenAI-style `after`/`has_more`
   * envelope). Items in this LIST response carry the turn-local delta in
   * `input_messages` — only the messages new to that turn.
   */
  listItems(
    conversationId: string,
    params?: ConversationItemListParams,
  ): Promise<ConversationItemList> {
    return this.http.request<ConversationItemList>({
      method: "GET",
      path: `/v1/conversations/${encodeURIComponent(conversationId)}/items`,
      query: params as Record<string, unknown> | undefined,
    });
  }

  /**
   * Iterate all items of a conversation. This envelope has NO `next`
   * token — paging is driven by `after` = the previous page's `last_id`
   * while `has_more` is true.
   */
  async *listItemsAll(
    conversationId: string,
    params?: ConversationItemListParams,
  ): AsyncIterable<ConversationItem> {
    let after: string | undefined = params?.after;
    for (;;) {
      const page = await this.listItems(conversationId, { ...params, after });
      for (const item of page.data) yield item;
      if (!page.has_more || page.last_id === null) return;
      after = page.last_id;
    }
  }

  /**
   * Fetch a single conversation item. Unlike the list route, the
   * detail's `input_messages` is the FULL input history for that span.
   */
  getItem(
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

  /**
   * High-level: fetch the full transcript of a conversation — every item
   * in ascending order, each carrying its per-turn input delta.
   */
  async retrieve(conversationId: string): Promise<ConversationTranscript> {
    const items: ConversationItem[] = [];
    for await (const item of this.listItemsAll(conversationId, {
      order: "asc",
    })) {
      items.push(item);
    }
    return { conversation_id: conversationId, items };
  }

  /**
   * High-level: load the "previous state" of a conversation — the full
   * input history, output, system instructions, and tool definitions of
   * the most recent LLM turn — as a Responses-API-style state object.
   *
   * The latest LLM turn is the first item (in descending order) whose
   * `node_type` is `"assistant"` or whose `operation_name` is `"chat"`,
   * falling back to the first item with a non-null `output_message`.
   * Returns `null` when the conversation has no items.
   */
  async state(conversationId: string): Promise<ConversationState | null> {
    let picked: ConversationItem | null = null;
    let fallback: ConversationItem | null = null;
    for await (const item of this.listItemsAll(conversationId, {
      order: "desc",
    })) {
      if (item.node_type === "assistant" || item.operation_name === "chat") {
        picked = item;
        break;
      }
      if (fallback === null && item.output_message != null) fallback = item;
    }
    const target = picked ?? fallback;
    if (target === null) return null;

    const detail = await this.getItem(conversationId, target.id, {
      include: STATE_INCLUDES,
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
}

/**
 * Defensive normalization for {@link ConversationsApi.state} only: older
 * DP deployments emitted `tool_call_response` parts with a legacy
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
