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
 * `signature` carries the encrypted reasoning payload (Anthropic
 * `signature` / `redacted_thinking`, OpenAI `encrypted_content`).
 * `redacted` is set when the upstream provider redacted the visible
 * content but kept the signed payload.
 */
export interface ReasoningPart {
  /** Discriminator — always `"thinking"`. */
  type: "thinking";
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

/** Union of all possible message-part shapes. */
export type MessagePart =
  | TextPart
  | ReasoningPart
  | ToolCallRequestPart
  | ToolCallResponsePart;

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
  COST_USD: "gen_ai.cost.usd",
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

/** Default span name builders for chat / execute_tool / invoke_agent. */
export const GenAiSpanName = {
  chat: (provider: string): string => `chat ${provider}`,
  executeTool: (toolName: string): string => `execute_tool ${toolName}`,
  invokeAgent: (agentName: string): string => `invoke_agent ${agentName}`,
};
