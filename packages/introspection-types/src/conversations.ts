/**
 * Read-only Conversations API types for the Introspection DP
 * `/v1/conversations` surface.
 *
 * Field names are kept on-the-wire (snake_case) to match the DP Pydantic
 * models verbatim (`introspection_dataplane/models/conversation.py`).
 *
 * The surface uses two distinct paging styles:
 *
 * - **Cursor paging** (`GET /v1/conversations`) — the standard
 *   Introspection envelope {@link Paginated} with an opaque `next` token.
 *   Pass the token back unchanged via the `next` query param.
 * - **After/has_more paging** (`GET /v1/conversations/{id}/items`) — an
 *   OpenAI-style envelope {@link ConversationItemList} with `first_id`,
 *   `last_id`, and `has_more`. There is NO `next` token: pass the
 *   previous page's `last_id` as the `after` query param while
 *   `has_more` is true.
 */

import type { IsoDate, ListParams, Uuid } from "./api.js";
import type {
  InputMessage,
  OutputMessage,
  SystemInstruction,
  ToolDefinition,
} from "./genai.js";

/** OpenTelemetry span status code values. */
export type SpanStatus = "Ok" | "Error" | "Unset";

/** OpenTelemetry span kind values. */
export type SpanKind =
  | "UNSPECIFIED"
  | "INTERNAL"
  | "SERVER"
  | "CLIENT"
  | "PRODUCER"
  | "CONSUMER";

/** Lightweight node type for conversation item trees. */
export type ConversationItemNodeType =
  | "agent"
  | "assistant"
  | "tool_call"
  | "span";

/**
 * Optional conversation item expansions, passed as a repeated `include`
 * query param on the items routes.
 */
export type ConversationItemInclude =
  | "gen_ai.input.messages"
  | "gen_ai.output.messages"
  | "gen_ai.system_instructions"
  | "gen_ai.tool.definitions"
  | "events"
  | "resource_attributes"
  | "span_attributes";

/**
 * Introspection-specific metadata enriched during trace ingestion.
 *
 * Derived from the `introspection.*` span attributes the SDK sets during
 * conversation linking / enrichment.
 */
export interface IntrospectionMetadata {
  /** Introspection member ID. */
  member_id?: string | null;
  /** Whether this is the first turn of a conversation. */
  is_new_conversation?: boolean | null;
  /** Position of this turn in the conversation (0-based). */
  conversation_position?: number | null;
  /** How this span was linked to a conversation (e.g. `"history"`, `"conversation_id"`). */
  continuation_method?: string | null;
  /** Whether the history hash lookup matched an existing conversation. */
  history_hash_hit?: boolean | null;
  /** Inclusive start index of newly added input messages in the full history. */
  new_messages_start?: number | null;
  /** Exclusive end index of newly added input messages in the full history. */
  new_messages_end?: number | null;
  /** Client-generated message ID for optimistic turn reconciliation. */
  client_message_id?: string | null;
}

/** An event within a span (exception, log message, state change, ...). */
export interface SpanEvent {
  /** Event timestamp. */
  timestamp: IsoDate;
  /** Event name. */
  name: string;
  /** Event attributes. */
  attributes: Record<string, unknown>;
}

/**
 * Canonical conversation item resource — one span of a conversation.
 *
 * In the items LIST response, `input_messages` carries the turn-local
 * delta (only the messages new to that turn). On the single-item GET,
 * `input_messages` is the FULL input history supplied to that span.
 */
export interface ConversationItem {
  /** Discriminator — always `"conversation.item"`. */
  object: "conversation.item";
  /** Conversation item identifier. */
  id: string;
  /** Item type — always `"span"`. */
  type: "span";
  /** Trace ID. */
  trace_id: string;
  /** Span ID. */
  span_id: string;
  /** Parent span ID. */
  parent_span_id?: string | null;
  /** Item creation timestamp. */
  created_at: IsoDate;
  /** Span name. */
  span_name: string;
  /** Span kind. */
  span_kind: SpanKind;
  /** Precomputed tree node type. */
  node_type: ConversationItemNodeType;
  /** GenAI operation name (e.g. `"chat"`, `"execute_tool"`). */
  operation_name?: string | null;
  /** Span status code. */
  status_code?: SpanStatus | null;
  /** Span status message. */
  status_message?: string | null;
  /** Agent name. */
  agent_name?: string | null;
  /** Resolved model name. */
  model_name?: string | null;
  /** Requested model name. */
  request_model?: string | null;
  /** Response model name. */
  response_model?: string | null;
  /** Model response identifier. */
  response_id?: string | null;
  /** OTel `service.name`. */
  service_name?: string | null;
  /** GenAI provider name. */
  provider_name?: string | null;
  /** Span duration in nanoseconds. */
  duration_ns?: number | null;
  /** Input token count. */
  input_tokens?: number | null;
  /** Output token count. */
  output_tokens?: number | null;
  /** Cache-read input token count. */
  cache_read_input_tokens?: number | null;
  /** Cache-creation input token count. */
  cache_creation_input_tokens?: number | null;
  /** Tool/function name for `execute_tool` spans. */
  tool_name?: string | null;
  /** Tool call identifier when available. */
  tool_call_id?: string | null;
  /** Raw JSON-encoded tool call arguments for `execute_tool` spans. */
  tool_call_arguments?: string | null;
  /** Tool definitions attached to this item. */
  tool_definitions?: ToolDefinition[] | null;
  /** Introspection metadata attached to this item. */
  introspection?: IntrospectionMetadata | null;
  /** Trimmed span attributes. */
  span_attributes?: Record<string, unknown> | null;
  /**
   * Sliced input messages — the per-turn delta on the list route, the
   * full input history on the single-item route.
   */
  input_messages: InputMessage[];
  /** Output message. */
  output_message?: OutputMessage | null;
  /** Span events when requested via `include=events`. */
  events?: SpanEvent[] | null;
  /** Resource attributes when requested via `include=resource_attributes`. */
  resource_attributes?: Record<string, unknown> | null;
  /** System instructions when requested via `include=gen_ai.system_instructions`. */
  system_instructions?: SystemInstruction[] | null;
  /** Original `gen_ai.input.messages` when requested via include. */
  gen_ai_input_messages?: InputMessage[] | null;
  /** Original `gen_ai.output.messages` when requested via include. */
  gen_ai_output_messages?: OutputMessage[] | null;
}

/**
 * OpenAI-style list envelope for conversation items.
 *
 * Unlike {@link Paginated}, there is no `next` token: page by passing
 * `last_id` as the `after` query param while `has_more` is true.
 */
export interface ConversationItemList {
  /** Discriminator — always `"list"`. */
  object: "list";
  /** Items in this page. */
  data: ConversationItem[];
  /** First item ID in this page. */
  first_id: string | null;
  /** Last item ID in this page — pass as `after` to fetch the next page. */
  last_id: string | null;
  /** Whether additional pages exist after this one. */
  has_more: boolean;
}

/**
 * Summary of a conversation, aggregated from trace spans.
 *
 * Returned by `GET /v1/conversations` inside the standard cursor
 * envelope `Paginated<ConversationSummary>`.
 */
export interface ConversationSummary {
  /** Trace ID. */
  trace_id: string;
  /** GenAI conversation ID. */
  conversation_id?: string | null;
  /** Organization ID. */
  org_id: Uuid;
  /** Project ID. */
  project_id: Uuid;
  /** Conversation start time. */
  start_time: IsoDate;
  /** Conversation end time. */
  end_time?: IsoDate | null;
  /** Total duration in milliseconds. */
  duration_ms: number;
  /** OTel `service.name` from the trace. */
  service_name?: string | null;
  /** Requested model name. */
  model?: string | null;
  /** Actual model name returned by the provider. */
  response_model?: string | null;
  /** Agent name. */
  agent_name?: string | null;
  /** Primary operation type. */
  operation_name?: string | null;
  /** Sum of input tokens across spans. */
  total_input_tokens: number;
  /** Sum of output tokens across spans. */
  total_output_tokens: number;
  /** Number of traces in the conversation. */
  trace_count: number;
  /** Number of spans in the trace. */
  span_count: number;
  /** Overall status. */
  status: SpanStatus;
  /** Whether any span has errors. */
  has_errors: boolean;
  /** Detected signal categories. */
  signal_categories: string[];
  /** New input messages from the first span. */
  input_messages: InputMessage[];
  /** Output messages from the last span. */
  output_messages: OutputMessage[];
  /** Introspection enrichment metadata. */
  introspection?: IntrospectionMetadata | null;
}

/**
 * Query params for `GET /v1/conversations` (cursor paging — `limit` /
 * `next` come from {@link ListParams}). All filters are optional and
 * combined with AND logic; date range filters are inclusive.
 */
export interface ConversationListParams extends ListParams {
  /** Filter: model name (exact match). */
  model?: string;
  /** Filter: agent name (exact match). */
  agent_name?: string;
  /** Filter: status — `"Ok"` or `"Error"`. */
  status?: SpanStatus;
  /** Filter: OTel service name (exact match). */
  service_name?: string;
  /** Filter: OTel service names (exact match, repeated param). */
  service_names?: string[];
  /** Start of date range (inclusive). */
  start_date?: IsoDate;
  /** End of date range (inclusive). */
  end_date?: IsoDate;
}

/**
 * Query params for `GET /v1/conversations/{id}/items` (after/has_more
 * paging — pass the previous page's `last_id` as `after`).
 */
export interface ConversationItemListParams {
  /** Maximum items per page (1-1000, server default 100). */
  limit?: number;
  /** Item ID after which to continue pagination. */
  after?: string;
  /** Sort order for items (server default `"desc"`). */
  order?: "asc" | "desc";
  /** Optional item expansions (repeated `include` param). */
  include?: ConversationItemInclude[];
  /** Filter items by agent name (exact match). */
  agent_name?: string;
  /** Filter items by service name (exact match). */
  service_name?: string;
  /** Filter items by operation name (exact match). */
  operation_name?: string;
  /** Filter items by existence of a raw attribute path. */
  has_attribute?: string;
}

/**
 * Responses-API-style view of a conversation — the full input history,
 * output, system instructions, and tool definitions of the most recent
 * LLM turn, analogous to retrieving the latest Response. Built
 * client-side by `ConversationsApi.retrieve()` from the single-item
 * detail route.
 */
export interface ConversationResponse {
  /** Conversation ID the state belongs to. */
  conversation_id: string;
  /** Provider response identifier of the latest turn, when available. */
  response_id: string | null;
  /** Conversation item ID the state was built from. */
  item_id: string;
  /** Timestamp of the latest turn. */
  created_at: IsoDate;
  /** Model used for the latest turn. */
  model: string | null;
  /** GenAI provider name of the latest turn. */
  provider_name: string | null;
  /** FULL input history supplied to the latest turn. */
  input_messages: InputMessage[];
  /** Output messages produced by the latest turn. */
  output_messages: OutputMessage[];
  /** System instructions attached to the latest turn. */
  system_instructions: SystemInstruction[] | null;
  /** Tool definitions attached to the latest turn. */
  tool_definitions: ToolDefinition[] | null;
}

/**
 * The read-only Conversations API surface, with the paging style each
 * method uses:
 *
 * - `"cursor"` — Introspection envelope ({@link Paginated}); drive the
 *   opaque `next` token through the `next` query param.
 * - `"after"` — OpenAI-style envelope ({@link ConversationItemList});
 *   drive `after` = previous page's `last_id` while `has_more` is true.
 * - `"none"` — single-resource GET, no paging.
 */
export const ConversationsMethods = {
  list: { method: "GET", path: "/v1/conversations", paging: "cursor" },
  "items.list": {
    method: "GET",
    path: "/v1/conversations/{conversation_id}/items",
    paging: "after",
  },
  "items.get": {
    method: "GET",
    path: "/v1/conversations/{conversation_id}/items/{item_id}",
    paging: "none",
  },
} as const;

/** Name of a method on the Conversations API surface. */
export type ConversationsMethod = keyof typeof ConversationsMethods;
