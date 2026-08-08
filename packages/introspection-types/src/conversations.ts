/**
 * Read-only Conversations API types for the Introspection DP
 * `/v1/conversations` surface.
 *
 * A conversation item **is** an OpenTelemetry span, so it is typed as one:
 * identity and timing at the top level, everything else under `attributes`
 * keyed by its OpenTelemetry semantic-convention name.
 * `attributes.gen_ai.request.model` is called that here because that is what
 * the SDK wrote when it created the span — there is no private dialect to
 * learn on top of a vocabulary the reader already knows.
 *
 * Conversation summaries are dedicated {@link Conversation} resources;
 * conversation items are OpenTelemetry spans:
 *
 * - `GET /v1/conversations` — conversation resources inside the standard
 *   cursor envelope `Paginated<Conversation>`.
 * - `GET /v1/conversations/{id}` — one conversation resource with the complete
 *   agent invocation index.
 * - `GET /v1/conversations/{id}/items` — that turn's delta, inside the
 *   OpenAI-style {@link GenAiSpanList} envelope whose pagination is driven by
 *   the opaque `next` token.
 * - `GET /v1/conversations/{id}/items/{item_id}` — the **full history** as of
 *   that turn, so a conversation can be resumed with complete context.
 *
 * **Absent means absent.** The server never serializes `null` on this
 * surface; a value that is not present is a key that is not there. Every
 * optional field below is therefore `?:` rather than `| null`.
 *
 * **The attribute tree is open.** The server returns attributes as stored,
 * not as an allow-list, so every attribute type below carries an index
 * signature. A customer's own `gen_ai.*` or domain attribute arrives on a
 * type that never declared it and still round-trips — closing these types
 * would reintroduce exactly the lossiness this representation exists to
 * remove. Field names are kept on-the-wire (snake_case) to match both the
 * semantic conventions and the server models verbatim.
 */

import type { CursorParams, IsoDate, ReadWindowParams, Uuid } from "./api.js";
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
  "UNSPECIFIED" | "INTERNAL" | "SERVER" | "CLIENT" | "PRODUCER" | "CONSUMER";

/** Allow-listed `sort` fields for `GET /v1/conversations`. */
export type ConversationSortField =
  "created" | "duration" | "turns" | "tokens" | "cost";

/**
 * Optional conversation item expansions, passed as a repeated `include`
 * query param on the items routes.
 *
 * Two kinds of value, told apart by the prefix:
 *
 * - **`gen_ai.*` — encrypted content channels.** System instructions and
 *   tool definitions are stripped out of the attribute map at ingest and
 *   envelope-encrypted separately, so each one you request costs a per-row
 *   decrypt and each one you omit is never even selected. They are
 *   independent knobs on purpose: an eval harness wants definitions without
 *   instructions, a prompt audit wants the reverse, a chatbot wants
 *   neither.
 * - **Bare names — structural chunks of the raw span** (`events`, the full
 *   `span_attributes` map, `resource_attributes`). The typed attribute tree
 *   on every response is built from materialized columns; `span_attributes`
 *   is the complete raw map for debuggers.
 *
 * The message-family expansions are gone: the detail read returns the full
 * message history unconditionally, so there is nothing left for them to
 * gate. A parameter that is always required is not a parameter, it is a trap
 * — forgetting `include=gen_ai.input.messages` used to silently fork a
 * conversation with one turn of context.
 */
export type ConversationItemInclude =
  | "gen_ai.system_instructions"
  | "gen_ai.tool.definitions"
  | "events"
  | "span_attributes"
  | "resource_attributes";

// --- gen_ai.* -------------------------------------------------------------

/** `gen_ai.operation.name` — `chat`, `execute_tool`, `invoke_agent`. */
export interface GenAiOperation {
  /** Operation name. */
  name?: string;
  [key: string]: unknown;
}

/** `gen_ai.provider.name`. Replaced the older `gen_ai.system`. */
export interface GenAiProvider {
  /** Provider name (e.g. `"anthropic"`, `"openai"`). */
  name?: string;
  [key: string]: unknown;
}

/** `gen_ai.conversation.id`. */
export interface GenAiConversation {
  /** GenAI conversation ID — the `/v1/conversations/{id}` path key. */
  id?: string;
  [key: string]: unknown;
}

/** `gen_ai.agent.*`. */
export interface GenAiAgent {
  /** Agent ID. */
  id?: string;
  /** Agent name. */
  name?: string;
  /** Agent description. */
  description?: string;
  [key: string]: unknown;
}

/** `gen_ai.request.*` — what was asked for. */
export interface GenAiRequest {
  /** Requested model. */
  model?: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  max_tokens?: number;
  seed?: number;
  stream?: boolean;
  [key: string]: unknown;
}

/** `gen_ai.response.*` — what came back. */
export interface GenAiResponse {
  /** Provider response identifier. */
  id?: string;
  /** Model that produced the response. */
  model?: string;
  /** Model-reported finish reasons. */
  finish_reasons?: string[];
  [key: string]: unknown;
}

/** A nested token count, e.g. `gen_ai.usage.cache_read.input_tokens`. */
export interface TokenCount {
  input_tokens?: number;
  [key: string]: unknown;
}

/**
 * `gen_ai.usage.*`.
 *
 * On an item these are that operation's usage. On a conversation summary
 * they are the conversation's totals — same attribute, same honest meaning
 * for its scope, disambiguated by which read the object came from.
 *
 * Cache tokens are standard: they were a local extension until the GenAI
 * conventions adopted them, and the nesting is the adopted spelling.
 */
export interface GenAiUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read?: TokenCount;
  cache_creation?: TokenCount;
  [key: string]: unknown;
}

/** `gen_ai.tool.call.*`. */
export interface GenAiToolCall {
  /** Tool call identifier. */
  id?: string;
  /** Raw JSON-encoded tool call arguments. */
  arguments?: string;
  [key: string]: unknown;
}

/** `gen_ai.tool.*`. */
export interface GenAiTool {
  /** Tool / function name. */
  name?: string;
  /** Tool type. */
  type?: string;
  /** Tool description. */
  description?: string;
  /** The call this `execute_tool` span represents. */
  call?: GenAiToolCall;
  /** Tool definitions offered to the model. */
  definitions?: ToolDefinition[];
  [key: string]: unknown;
}

/**
 * `gen_ai.input.messages`.
 *
 * Full history on item detail; the turn-local delta on the items list.
 */
export interface GenAiInput {
  messages?: InputMessage[];
  [key: string]: unknown;
}

/** `gen_ai.output.messages`. */
export interface GenAiOutput {
  messages?: OutputMessage[];
  [key: string]: unknown;
}

/**
 * `gen_ai.cost.usd`.
 *
 * Not part of the published semantic conventions, but this is the name the span
 * is *written* with — the platform's cost column is materialized from
 * `gen_ai.cost.usd` — so the read returns it under the name it was stored as
 * rather than relocating it into `introspection.*`.
 *
 * Scoped by which read returned the span, the same way `gen_ai.usage.*` is:
 * this operation's cost on an item, the conversation total on a summary.
 *
 * Distinct from `introspection.llm.cost_usd`, which is the *provider*-reported
 * figure (e.g. OpenRouter's `usage.cost`) rather than the SDK's own
 * calculation. Both can be present; they are different measurements.
 */
export interface GenAiCost {
  usd?: number;
  [key: string]: unknown;
}

/** The `gen_ai.*` attribute family, nested as the convention names it. */
export interface GenAiSpanAttributes {
  operation?: GenAiOperation;
  provider?: GenAiProvider;
  conversation?: GenAiConversation;
  agent?: GenAiAgent;
  request?: GenAiRequest;
  response?: GenAiResponse;
  usage?: GenAiUsage;
  cost?: GenAiCost;
  tool?: GenAiTool;
  input?: GenAiInput;
  output?: GenAiOutput;
  /** `gen_ai.system_instructions`. */
  system_instructions?: SystemInstruction[];
  [key: string]: unknown;
}

// --- introspection.* ------------------------------------------------------

/** An `{id}` node — `introspection.org.id` and friends. */
export interface IntrospectionId {
  id?: string;
  [key: string]: unknown;
}

/** `introspection.runtime.*`. */
export interface IntrospectionRuntime {
  /** Runtime version ID. */
  id?: string;
  /** Stable runtime group ID. */
  group_id?: string;
  [key: string]: unknown;
}

/** `introspection.recipe.*`. */
export interface IntrospectionRecipe {
  /** Recipe git commit SHA. */
  git_commit_sha?: string;
  [key: string]: unknown;
}

/**
 * `introspection.conversation.*`.
 *
 * On an item these describe the turn's place in the conversation. On a
 * summary the counts describe the conversation as a whole — these are the
 * rollups with no semantic-convention name, which is why they live here
 * rather than under `gen_ai`: claiming a `gen_ai.*` name for them would
 * assert a standard meaning that does not exist.
 */
export interface IntrospectionConversation {
  /** Position of this turn in the conversation (0-based). */
  position?: number;
  /** Whether this is the first turn of a conversation. */
  is_new?: boolean;
  /** How this span was linked to a conversation (e.g. `"conversation_id"`). */
  continuation_method?: string;
  /** Whether the history hash lookup matched an existing conversation. */
  history_hash_hit?: boolean;
  /** Inclusive start index of newly added input messages in the full history. */
  new_messages_start?: number;
  /** Exclusive end index of newly added input messages in the full history. */
  new_messages_end?: number;
  /** Client-generated message ID for optimistic turn reconciliation. */
  client_message_id?: string;
  /** Number of traces in the conversation (summary rollup). */
  trace_count?: number;
  /** Number of spans in the conversation (summary rollup). */
  span_count?: number;
  /** Number of `execute_tool` spans in the conversation (summary rollup). */
  tool_use_count?: number;
  /** Number of failed `execute_tool` spans (summary rollup). */
  failed_tool_use_count?: number;
  /** Whether any span in the conversation has errors (summary rollup). */
  has_errors?: boolean;
  [key: string]: unknown;
}

/** One agent invocation discoverable from a conversation summary. */
export interface ConversationAgent {
  /** Identifier accepted by the items `agent` selector. */
  id: string;
  name?: string;
  /** Parent agent identifier; absent for the root. */
  parent_id?: string;
  /** Delegation invocation correlation identifier. */
  invocation_id?: string;
  /** Zero-based delegation depth. */
  depth?: number;
}

export interface ConversationUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface ConversationCost {
  usd: number;
}

export interface ConversationMetrics {
  duration_ms: number;
  trace_count: number;
  span_count: number;
  tool_use_count: number;
  failed_tool_use_count: number;
  has_errors: boolean;
}

/** Aggregated conversation resource returned by summary reads. */
export interface Conversation {
  object: "conversation";
  id: string;
  created_at: IsoDate;
  updated_at: IsoDate;
  /** Complete only on the singular conversation read. */
  agents?: ConversationAgent[];
  usage: ConversationUsage;
  cost: ConversationCost;
  metrics: ConversationMetrics;
  environment?: string;
  service_name?: string;
  runtime_id?: Uuid;
  runtime_group_id?: Uuid;
  experiment_id?: Uuid;
  recipe_git_commit_sha?: string;
  owner_key?: string;
}

/**
 * The `introspection.*` attribute family.
 *
 * Everything here is ours — the rollup counts that have no semantic-convention
 * name, and the tenancy identifiers. Cost is *not* here: it is written as
 * `gen_ai.cost.usd`, so it stays there (see {@link GenAiCost}).
 */
export interface IntrospectionSpanAttributes {
  org?: IntrospectionId;
  project?: IntrospectionId;
  member?: IntrospectionId;
  run?: IntrospectionId;
  task?: IntrospectionId;
  runtime?: IntrospectionRuntime;
  experiment?: IntrospectionId;
  recipe?: IntrospectionRecipe;
  /** Runtime environment lane. */
  environment?: string;
  conversation?: IntrospectionConversation;
  agent?: IntrospectionAgent;
  [key: string]: unknown;
}

/**
 * `introspection.agent.*` — the agent-tree edge on a span. On a delegation
 * wrapper span, `parent_id` is the delegating agent (empty/absent = root)
 * and `invocation_id` is the durable child agent-run id — the delegation's
 * cross-transport correlation key.
 */
export interface IntrospectionAgent {
  parent_id?: string;
  invocation_id?: string;
  [key: string]: unknown;
}

// --- the span -------------------------------------------------------------

/**
 * The span's attribute tree.
 *
 * Typed for the two families whose meaning we own; open for everything
 * else, so an attribute nobody modelled survives the round trip.
 */
export interface SpanAttributes {
  gen_ai?: GenAiSpanAttributes;
  introspection?: IntrospectionSpanAttributes;
  [key: string]: unknown;
}

/** OTel resource attributes, nested the way the resource names them. */
export interface SpanResource {
  service?: {
    /** OTel `service.name`. */
    name?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/** OpenTelemetry span status. */
export interface GenAiSpanStatus {
  /** Span status code. */
  code?: SpanStatus;
  /** Span status message. */
  message?: string;
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
 * One conversation item returned by the items surface.
 *
 * The top level is closed because the server constructs it: these are the
 * OTel span fields, not attributes. Openness lives where the server has no
 * say over the keys — inside {@link attributes} and {@link resource}.
 */
export interface GenAiSpan {
  /** Trace ID. */
  trace_id: string;
  /** Span ID. Also the `{item_id}` of the item detail route. */
  span_id?: string;
  /** Parent span ID. */
  parent_span_id?: string;
  /** Span name. */
  name?: string;
  /** Span kind. */
  kind?: SpanKind;
  /** Span start time. */
  start_time: IsoDate;
  /** Span end time. */
  end_time?: IsoDate;
  /** Span duration in nanoseconds. */
  duration_ns?: number;
  /** Span status — omitted entirely when it would say nothing. */
  status?: GenAiSpanStatus;
  /** OTel resource attributes. */
  resource?: SpanResource;
  /** Span events, when requested via `include=events`. */
  events?: SpanEvent[];
  /** Span attributes, keyed by semantic-convention name. */
  attributes: SpanAttributes;
}

/**
 * OpenAI-style list envelope for conversation items.
 *
 * Pagination uses the opaque `next` token. `first_id` and `last_id` are
 * informational and are not valid pagination inputs.
 */
export interface GenAiSpanList {
  /** Discriminator — always `"list"`. */
  object: "list";
  /** Spans in this page. */
  data: GenAiSpan[];
  /** First span ID in this page. */
  first_id: string | null;
  /** Last span ID in this page. */
  last_id: string | null;
  /** Whether additional pages exist after this one. */
  has_more: boolean;
  /** Opaque cursor for the next page, or null when exhausted. */
  next: string | null;
}

/**
 * `attributes.gen_ai.conversation.id`, if present.
 *
 * The nested tree is worth its cost everywhere except the two or three
 * reads every caller makes, so those pay it once here instead of at each
 * call site.
 */
export function genAiConversationId(span: GenAiSpan): string | undefined {
  return span.attributes.gen_ai?.conversation?.id;
}

/** `attributes.gen_ai.input.messages` — empty rather than absent. */
export function genAiInputMessages(span: GenAiSpan): InputMessage[] {
  return span.attributes.gen_ai?.input?.messages ?? [];
}

/** `attributes.gen_ai.output.messages` — empty rather than absent. */
export function genAiOutputMessages(span: GenAiSpan): OutputMessage[] {
  return span.attributes.gen_ai?.output?.messages ?? [];
}

/**
 * Query params for `GET /v1/conversations` (cursor paging — `limit` /
 * `next` come from {@link CursorParams}). All filters are optional and
 * combined with AND logic; date range filters are inclusive.
 */
export interface ConversationListParams extends CursorParams, ReadWindowParams {
  /** Filter: conversation ID (exact match). */
  conversation_id?: string;
  /** Summary field to order by (server default `"created"`). */
  sort?: ConversationSortField;
  /**
   * Sort direction (server default `"desc"`). Prefer `order` from
   * {@link ReadWindowParams}; when both are set `order` wins.
   */
  direction?: "asc" | "desc";
  /** Filter: requested model on any span (exact match). */
  model?: string;
  /** Filter: agent name (exact match). */
  agent_name?: string;
  /** Filter: status — `"Ok"` or `"Error"`. */
  status?: SpanStatus;
  /** Filter: OTel service name (exact match). */
  service_name?: string;
  /** Filter: OTel service names (exact match, repeated param). */
  service_names?: string[];
  /** Filter: runtime environment lane. */
  environment?: string;
  /** Filter: runtime version ID. */
  runtime_id?: Uuid;
  /** Filter: stable runtime group ID. */
  runtime_group_id?: Uuid;
  /** Filter: experiment ID. */
  experiment_id?: Uuid;
  /** Filter: recipe git commit SHA. */
  recipe_git_commit_sha?: string;
  /** Start of date range (inclusive). */
  start_date?: IsoDate;
  /** End of date range (inclusive). */
  end_date?: IsoDate;
}

/**
 * Query params for `GET /v1/conversations/{id}/items`.
 */
export interface ConversationItemListParams {
  /** Maximum items per page (1-1000, server default 100). */
  limit?: number;
  /** Opaque cursor returned by the previous page. */
  next?: string;
  /** Sort order for items (server default `"desc"`). */
  order?: "asc" | "desc";
  /** Optional item expansions (repeated `include` param). */
  include?: ConversationItemInclude[];
  /**
   * Agent selector. `"root"` returns the depth-zero transcript; an exact
   * agent id returns that invocation. Omit the parameter for the complete
   * conversation. Discover exact ids from `agents` on the singular
   * conversation resource.
   */
  agent?: string;
  /** Filter items by service name (exact match). */
  service_name?: string;
  /** Filter items by operation name (exact match). */
  operation_name?: string;
  /** Filter items by existence of a raw attribute path. */
  has_attribute?: string;
}

/**
 * Query params for `GET /v1/conversations/{id}/export`.
 *
 * The export is a complete, server-assembled conversation, so it carries
 * no pagination: these are filters over what gets assembled, not a page
 * window.
 */
export interface ConversationExportParams {
  /**
   * Agent selector. `"root"` returns the depth-zero transcript; an exact
   * agent id returns that invocation. Omit for the complete conversation.
   */
  agent?: string;
  /** Filter items by service name (exact match). */
  service_name?: string;
  /** Filter items by operation name (exact match). */
  operation_name?: string;
  /** Partition lookback bound in days (1-365). */
  lookback_days?: number;
  /** Read via a `/v1/shares` grant for this conversation. */
  share_id?: Uuid;
  /**
   * Lower bound on which records are assembled (ISO 8601).
   *
   * Named for the wire rather than aliased to `start`/`end` like the list
   * params, because this route's relative window is the separate
   * `lookback_days` integer.
   */
  start_date?: string;
  /** Upper bound on which records are assembled (ISO 8601). */
  end_date?: string;
}

/**
 * One tool invocation inside a {@link TrajectoryAssistantRecord}.
 *
 * `args` is a **JSON-encoded string**, not an object — that is the
 * upstream trajectory-v1 contract, not an oversight here. The encoded
 * value is an object; a malformed or scalar source value arrives as
 * `{"_raw": ...}` so the evidence survives without breaking the schema.
 */
export interface TrajectoryToolCall {
  /** Identifier linking this call to its {@link TrajectoryToolRecord}. */
  id: string;
  /** Tool/function name. */
  name: string;
  /** JSON-encoded arguments object. */
  args: string;
}

/** Leading record identifying the session the trajectory came from. */
export interface TrajectoryMetaRecord {
  role: "meta";
  /** Harness that produced the session, e.g. `"claude-code"`. */
  source: string;
  cwd?: string;
  git_branch?: string;
  model?: string;
}

/** A user turn. */
export interface TrajectoryUserRecord {
  role: "user";
  content: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
}

/** Model reasoning, when the source exposed it. */
export interface TrajectoryReasoningRecord {
  role: "reasoning";
  content: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
}

/**
 * An assistant turn — prose, or tool calls, never both.
 *
 * The two are distinguished by `content`: a prose record carries text and
 * no `tool_calls`; a tool-call record carries `content: null`. That null
 * is load-bearing and is always present on the wire, so it is typed as
 * `string | null` rather than optional.
 */
export interface TrajectoryAssistantRecord {
  role: "assistant";
  content: string | null;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Present only on a tool-call record, and then never empty. */
  tool_calls?: TrajectoryToolCall[];
}

/** A tool result, linked to its call by `tool_call_id`. */
export interface TrajectoryToolRecord {
  role: "tool";
  tool_call_id: string;
  content: string;
  /** ISO-8601 timestamp. */
  timestamp: string;
  /** Source-native success status; absent when the source exposes none. */
  ok?: boolean;
}

/** One record in a trajectory-v1 export, discriminated by `role`. */
export type TrajectoryRecord =
  | TrajectoryMetaRecord
  | TrajectoryUserRecord
  | TrajectoryReasoningRecord
  | TrajectoryAssistantRecord
  | TrajectoryToolRecord;

/**
 * The trajectory-v1 wire shape: a non-empty top-level array of records.
 *
 * This is a projection derived on read from the stored GenAI messages, not
 * a second storage format, so it is available for export only — nothing
 * accepts a trajectory as input.
 */
export type Trajectory = TrajectoryRecord[];

/**
 * The read-only Conversations API surface, with the paging style each
 * method uses:
 *
 * - `"cursor"` — Introspection envelope ({@link Paginated}); drive the
 *   opaque `next` token through the `next` query param.
 * - `"none"` — single-resource GET, no paging.
 */
export const ConversationsMethods = {
  list: { method: "GET", path: "/v1/conversations", paging: "cursor" },
  "items.list": {
    method: "GET",
    path: "/v1/conversations/{conversation_id}/items",
    paging: "cursor",
  },
  "items.get": {
    method: "GET",
    path: "/v1/conversations/{conversation_id}/items/{item_id}",
    paging: "none",
  },
  export: {
    method: "GET",
    path: "/v1/conversations/{conversation_id}/export",
    paging: "none",
  },
} as const;

/** Name of a method on the Conversations API surface. */
export type ConversationsMethod = keyof typeof ConversationsMethods;
