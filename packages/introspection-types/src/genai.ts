/**
 * OTel Gen AI Semantic Convention types.
 *
 * Standardized JSON shapes for the `gen_ai.input.messages`,
 * `gen_ai.output.messages`, `gen_ai.system_instructions`, and
 * `gen_ai.tool.definitions` span attributes.
 *
 * Used by all `@introspection-sdk/*` packages that emit GenAI spans:
 * `introspection-node`, `introspection-openclaw`, `introspection-pi-agent`.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */

/**
 * A text content part in a message.
 *
 * `text_signature` carries opaque per-block signatures used by some
 * providers (e.g. OpenAI Responses message metadata) so a replayed
 * conversation can be sent back to the same provider without losing
 * signed continuity.
 */
export interface TextPart {
  /** Discriminator — always `"text"`. */
  type: "text";
  /** The text body of this part. */
  content: string;
  /** Optional opaque per-block signature for replay continuity. */
  text_signature?: string;
}

/**
 * A reasoning / thinking content part in a message.
 *
 * The OTel GenAI semconv message schemas define this part with the
 * `"reasoning"` discriminator; `"thinking"` is a legacy value that older
 * converters emitted and readers must keep accepting.
 *
 * `signature` carries the encrypted reasoning payload (Anthropic
 * `signature` / `redacted_thinking`, OpenAI `encrypted_content`).
 * `redacted` is set when the upstream provider redacted the visible
 * content but kept the signed payload.
 */
export interface ReasoningPart {
  /** Discriminator — `"reasoning"` (semconv) or `"thinking"` (legacy). */
  type: "reasoning" | "thinking";
  /** The reasoning / thinking summary content. */
  content?: string;
  /** Encrypted reasoning signature (Anthropic signature / redacted_thinking, OpenAI encrypted_content). */
  signature?: string;
  /** Provider that produced this thinking block (e.g. `"anthropic"`, `"openai"`). Used to reconstruct the correct wire format on replay. */
  provider_name?: string;
  /** True when the thinking content was redacted by safety filters but the signed payload is preserved. */
  redacted?: boolean;
}

/** A tool / function-call request part in a message. */
export interface ToolCallRequestPart {
  /** Discriminator — always `"tool_call"`. */
  type: "tool_call";
  /** Function / tool name. */
  name: string;
  /** Correlation ID linking request to response. */
  id?: string;
  /** Arguments passed to the tool. */
  arguments?: unknown;
}

/** A tool / function-call response part in a message. */
export interface ToolCallResponsePart {
  /** Discriminator — always `"tool_call_response"`. */
  type: "tool_call_response";
  /** The value returned by the tool. */
  response: unknown;
  /** Correlation ID linking response to request. */
  id?: string;
  /** Optional tool name. Stored on `tool` messages whose tool_call counterpart was lost. */
  name?: string;
}

/**
 * A media content part referenced by URL.
 *
 * The `type` discriminator names the media kind (image / audio / video /
 * document); the payload itself lives behind `url`.
 */
export interface MediaUrlPart {
  /** Discriminator — the media kind. */
  type: "image-url" | "audio-url" | "video-url" | "document-url";
  /** URL to the media content. */
  url?: string;
}

/**
 * A binary data part carrying inline base64-encoded content.
 *
 * Used when media is embedded directly in the message instead of being
 * referenced by URL.
 */
export interface BinaryDataPart {
  /** Discriminator — always `"binary"`. */
  type: "binary";
  /** MIME type of the content (e.g. `"image/png"`). */
  media_type: string;
  /** Base64-encoded content. */
  content?: string;
}

/**
 * A blob part per the OTel GenAI message schemas (inline binary data such
 * as an image sent to the model).
 *
 * `content` (base64) is optional in this SDK: instrumentations omit the
 * payload to keep span attribute sizes bounded, recording only the
 * modality / MIME type so the message structure is preserved.
 */
export interface BlobPart {
  /** Discriminator — always `"blob"`. */
  type: "blob";
  /** General modality of the data (e.g. `"image"`, `"audio"`). */
  modality?: string;
  /** IANA MIME type of the data (e.g. `"image/png"`). */
  mime_type?: string;
  /** Base64-encoded payload, when captured. */
  content?: string;
}

/**
 * A compacted-history summary part.
 *
 * Emitted when an agent compacts its conversation history: the model-visible
 * summary that replaced the compacted messages, without the prose wrapper the
 * agent renders around it (e.g. Pi's "The conversation history before this
 * point was compacted…" preamble).
 */
export interface CompactionPart {
  /** Discriminator — always `"compaction"`. */
  type: "compaction";
  /** Compacted summary text shown to the model. */
  content: string;
}

/** Union of all possible message-part shapes. */
export type MessagePart =
  | TextPart
  | ReasoningPart
  | ToolCallRequestPart
  | ToolCallResponsePart
  | CompactionPart
  | MediaUrlPart
  | BinaryDataPart
  | BlobPart;

/** A system instruction entry for `gen_ai.system_instructions`. */
export interface SystemInstruction {
  /** Part type — always `"text"`. */
  type: "text";
  /** The instruction text content. */
  content: string;
}

/** Roles allowed on input/output messages. */
export type MessageRole = "system" | "user" | "assistant" | "tool";

/**
 * An input message (`gen_ai.input.messages` element).
 */
export interface InputMessage {
  role: MessageRole;
  parts: MessagePart[];
  /** Optional tool name when `role` is `"tool"`. */
  name?: string;
}

/**
 * An output message (`gen_ai.output.messages` element).
 */
export interface OutputMessage {
  role: MessageRole;
  parts: MessagePart[];
  /** Model-reported finish reason (e.g. `"stop"`, `"length"`, `"tool_use"`). */
  finish_reason?: string;
  /** Optional tool name when `role` is `"tool"`. */
  name?: string;
  /** Provider name as reported by the model — useful when output messages are replayed across providers. */
  provider?: string;
  /** Concrete model id used for the response. */
  model?: string;
  /** API surface used to produce this response (e.g. `"openai-responses"`). */
  api?: string;
  /** Provider-specific response identifier when the upstream API exposes one. */
  response_id?: string;
}

/** A tool definition for the `gen_ai.tool.definitions` attribute. */
export interface ToolDefinition {
  /** Tool / function name. */
  name: string;
  /** Human-readable description of what the tool does. */
  description?: string;
  /** JSON Schema describing the tool's parameters. */
  parameters?: unknown;
}

/**
 * Camel-cased GenAI attribute bag, convenient for callers that don't want to
 * deal with OTel's dotted attribute names directly.
 *
 * {@link toAttributes} converts this to a flat OTel attribute record with
 * `gen_ai.*` keys (primitive arrays like `finishReasons` pass through as
 * native string arrays; nested objects are JSON-serialized).
 */
export interface GenAiAttributes {
  /** Model name (gen_ai.request.model) */
  requestModel?: string;
  /** Provider name (gen_ai.provider.name) */
  providerName?: string;
  /**
   * Legacy provider name (gen_ai.system).
   * @deprecated Prefer {@link GenAiAttributes.providerName} (`gen_ai.provider.name`).
   */
  system?: string;
  /** Operation name (gen_ai.operation.name) */
  operationName?: string;
  /** Tool definitions (gen_ai.tool.definitions) — serialized to JSON by {@link toAttributes}. */
  toolDefinitions?: ToolDefinition[];
  /** Input messages (gen_ai.input.messages) — serialized to JSON by {@link toAttributes}. */
  inputMessages?: InputMessage[];
  /** Output messages (gen_ai.output.messages) — serialized to JSON by {@link toAttributes}. */
  outputMessages?: OutputMessage[];
  /** System instructions (gen_ai.system_instructions) — serialized to JSON by {@link toAttributes}. */
  systemInstructions?: SystemInstruction[];
  /** Response ID (gen_ai.response.id) */
  responseId?: string;
  /** Response model (gen_ai.response.model) */
  responseModel?: string;
  /** Finish reason array (gen_ai.response.finish_reasons) — emitted as a native OTel string array. */
  finishReasons?: string[];
  /** Input token count (gen_ai.usage.input_tokens) */
  inputTokens?: number;
  /** Output token count (gen_ai.usage.output_tokens) */
  outputTokens?: number;
  /** Cache creation input tokens (gen_ai.usage.cache_creation.input_tokens) */
  cacheCreationInputTokens?: number;
  /** Cache read input tokens (gen_ai.usage.cache_read.input_tokens) */
  cacheReadInputTokens?: number;
  /** Cost in USD (gen_ai.cost.usd) */
  costUsd?: number;
}

const ATTRIBUTE_NAMES: Record<keyof GenAiAttributes, string> = {
  requestModel: "gen_ai.request.model",
  providerName: "gen_ai.provider.name",
  system: "gen_ai.system",
  operationName: "gen_ai.operation.name",
  toolDefinitions: "gen_ai.tool.definitions",
  inputMessages: "gen_ai.input.messages",
  outputMessages: "gen_ai.output.messages",
  systemInstructions: "gen_ai.system_instructions",
  responseId: "gen_ai.response.id",
  responseModel: "gen_ai.response.model",
  finishReasons: "gen_ai.response.finish_reasons",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  cacheCreationInputTokens: "gen_ai.usage.cache_creation.input_tokens",
  cacheReadInputTokens: "gen_ai.usage.cache_read.input_tokens",
  costUsd: "gen_ai.cost.usd",
};

/**
 * Convert a {@link GenAiAttributes} object into an OTel-compatible
 * attribute record with `gen_ai.*` dotted keys.
 *
 * Properties that are `undefined` are omitted. Primitive arrays (e.g.
 * `finishReasons: string[]`) pass through as native OTel string arrays.
 * Object-valued properties (`toolDefinitions`, `inputMessages`, …) are
 * JSON-serialized with `null` and `undefined` stripped, since OTel
 * attributes can't carry nested objects.
 */
export function toAttributes(
  attrs: GenAiAttributes,
): Record<string, string | number | string[] | number[]> {
  const result: Record<string, string | number | string[] | number[]> = {};

  for (const key of Object.keys(attrs) as (keyof GenAiAttributes)[]) {
    const value = attrs[key];
    if (value === undefined) continue;
    const otelKey = ATTRIBUTE_NAMES[key];
    if (typeof value === "string" || typeof value === "number") {
      result[otelKey] = value;
    } else if (isPrimitiveArray(value)) {
      result[otelKey] = value as string[] | number[];
    } else {
      result[otelKey] = JSON.stringify(stripNullish(value));
    }
  }

  return result;
}

function isPrimitiveArray(value: unknown): value is string[] | number[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) => typeof entry === "string" || typeof entry === "number",
    )
  );
}

/**
 * Recursively strip `undefined` and `null` values from an object before
 * JSON serialization. Equivalent to Python's `model_dump(exclude_none=True)`.
 */
function stripNullish(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNullish);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (entry !== undefined && entry !== null) {
        out[key] = stripNullish(entry);
      }
    }
    return out;
  }
  return value;
}

/**
 * GenAI semantic-convention attribute names.
 *
 * Useful when setting attributes on a span directly (`span.setAttributes`)
 * without going through {@link toAttributes}.
 */
export const GenAi = {
  CONVERSATION_ID: "gen_ai.conversation.id",
  AGENT_ID: "gen_ai.agent.id",
  AGENT_NAME: "gen_ai.agent.name",
  OPERATION_NAME: "gen_ai.operation.name",
  PROVIDER_NAME: "gen_ai.provider.name",
  REQUEST_MODEL: "gen_ai.request.model",
  RESPONSE_MODEL: "gen_ai.response.model",
  RESPONSE_ID: "gen_ai.response.id",
  RESPONSE_FINISH_REASONS: "gen_ai.response.finish_reasons",
  USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  USAGE_CACHE_READ_INPUT_TOKENS: "gen_ai.usage.cache_read.input_tokens",
  USAGE_CACHE_CREATION_INPUT_TOKENS: "gen_ai.usage.cache_creation.input_tokens",
  USAGE_REASONING_TOKENS: "gen_ai.usage.reasoning.output_tokens",
  /**
   * Extension attribute (not part of the GenAI semconv registry): total
   * computed cost of the call in USD. Kept under `gen_ai.` for downstream
   * compatibility; a coordinated move to the `introspection.` namespace is
   * pending.
   */
  COST_USD: "gen_ai.cost.usd",
  TOOL_DESCRIPTION: "gen_ai.tool.description",
  INPUT_MESSAGES: "gen_ai.input.messages",
  OUTPUT_MESSAGES: "gen_ai.output.messages",
  SYSTEM_INSTRUCTIONS: "gen_ai.system_instructions",
  TOOL_DEFINITIONS: "gen_ai.tool.definitions",
  TOOL_NAME: "gen_ai.tool.name",
  TOOL_TYPE: "gen_ai.tool.type",
  TOOL_CALL_ID: "gen_ai.tool.call.id",
  TOOL_CALL_ARGUMENTS: "gen_ai.tool.call.arguments",
  TOOL_CALL_RESULT: "gen_ai.tool.call.result",
} as const;

/**
 * Introspection-namespaced span attribute names (companions to the GenAI
 * semconv attributes above).
 */
export const IntrospectionAttr = {
  TERMINATION_REASON: "introspection.termination_reason",
  /** Provider-reported total cost of the call in USD (e.g. OpenRouter `usage.cost`). */
  LLM_COST_USD: "introspection.llm.cost_usd",
  /** Provider-reported upstream inference cost in USD (OpenRouter `usage.cost_details.upstream_inference_cost`). */
  LLM_UPSTREAM_COST_USD: "introspection.llm.upstream_cost_usd",
} as const;

/**
 * Extract provider-reported cost attributes from a raw LLM usage block.
 *
 * OpenAI-compatible gateways (e.g. OpenRouter with `usage: {include: true}`)
 * report the price charged for the call directly inside the usage payload.
 * Provider-reported cost is the ceiling comparison point vs table pricing in
 * platform billing, so instrumentations attach it whenever the provider
 * surfaces it:
 *
 * - `usage.cost` → `introspection.llm.cost_usd`
 * - `usage.cost_details.upstream_inference_cost` →
 *   `introspection.llm.upstream_cost_usd`
 * - `usage.completion_tokens_details.reasoning_tokens` →
 *   `gen_ai.usage.reasoning.output_tokens`
 *
 * Fields that are absent or non-numeric are skipped: the result only ever
 * contains attributes whose source value was present and a finite number, so
 * callers can pass the returned record straight to `span.setAttributes()`.
 */
export function providerCostAttributes(usage: unknown): Record<string, number> {
  const attrs: Record<string, number> = {};
  if (usage === null || typeof usage !== "object") return attrs;
  const usageRecord = usage as Record<string, unknown>;

  if (isFiniteNumber(usageRecord.cost)) {
    attrs[IntrospectionAttr.LLM_COST_USD] = usageRecord.cost;
  }

  const costDetails = usageRecord.cost_details;
  if (costDetails !== null && typeof costDetails === "object") {
    const upstreamCost = (costDetails as Record<string, unknown>)
      .upstream_inference_cost;
    if (isFiniteNumber(upstreamCost)) {
      attrs[IntrospectionAttr.LLM_UPSTREAM_COST_USD] = upstreamCost;
    }
  }

  const completionDetails = usageRecord.completion_tokens_details;
  if (completionDetails !== null && typeof completionDetails === "object") {
    const reasoningTokens = (completionDetails as Record<string, unknown>)
      .reasoning_tokens;
    if (isFiniteNumber(reasoningTokens)) {
      attrs[GenAi.USAGE_REASONING_TOKENS] = reasoningTokens;
    }
  }

  return attrs;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * How a requested abort is classified on a span
 * (`introspection.termination_reason`): `cancelled` for a user/runtime stop,
 * `awaiting_user` for a turn paused on an interrupt. Turn (`invoke_agent`)
 * spans additionally use `completed` and `error` for non-aborted endings.
 */
export type AbortTerminationReason = "cancelled" | "awaiting_user";

/** Default span name builders for chat / execute_tool / invoke_agent. */
export const GenAiSpanName = {
  chat: (provider: string): string => `chat ${provider}`,
  executeTool: (toolName: string): string => `execute_tool ${toolName}`,
  invokeAgent: (agentName: string): string => `invoke_agent ${agentName}`,
};
