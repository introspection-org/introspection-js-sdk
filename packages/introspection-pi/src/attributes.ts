/**
 * Attribute-record builders for chat / execute_tool spans.
 *
 * Builds plain `Attributes` records rather than mutating spans so callers
 * can inspect, log, and merge with their own attributes (`extraAttributes`
 * hook, environment-derived tenant labels, etc.).
 */

import type { Attributes } from "@opentelemetry/api";
import type {
  AssistantMessage,
  Context,
  Model,
  SimpleStreamOptions,
  Tool,
} from "@earendil-works/pi-ai";
import {
  GenAi,
  type InputMessage,
  type OutputMessage,
  type ToolDefinition,
} from "@introspection-sdk/types";
import {
  assistantToOutputMessages,
  messagesToInputMessages,
  semconvFinishReason,
  systemPromptToInstructions,
  type ConvertOptions,
} from "./convert.js";

const MAX_BYTES = 64_000;

/**
 * pi-ai provider ids whose semconv `gen_ai.provider.name` well-known value
 * spells differently. The spec requires the well-known value whenever one
 * applies; ids without an entry (including pi providers the registry has no
 * value for, e.g. `openrouter`, `cerebras`) pass through unchanged.
 */
const SEMCONV_PROVIDER_NAMES: Record<string, string> = {
  "amazon-bedrock": "aws.bedrock",
  "azure-openai-responses": "azure.ai.openai",
  google: "gcp.gemini",
  "google-vertex": "gcp.vertex_ai",
  mistral: "mistral_ai",
  moonshotai: "moonshot_ai",
  "moonshotai-cn": "moonshot_ai",
  xai: "x_ai",
};

/** Map a pi-ai provider id to the semconv `gen_ai.provider.name` value. */
export function semconvProviderName(provider: string): string {
  return SEMCONV_PROVIDER_NAMES[provider] ?? provider;
}

/**
 * `server.address` / `server.port` derived from the model's base URL.
 * Returns an empty record when the URL cannot be parsed.
 */
export function serverAttributes(baseUrl: string): Attributes {
  try {
    const url = new URL(baseUrl);
    const port = url.port
      ? Number(url.port)
      : url.protocol === "http:"
        ? 80
        : 443;
    return { "server.address": url.hostname, "server.port": port };
  } catch {
    return {};
  }
}

/** Metadata that the consumer attaches to every chat / tool span. */
export interface AgentMeta {
  conversationId: string;
  agentId: string;
  agentName: string;
}

interface ChatRequestAttributeOptions extends ConvertOptions {
  streamOptions?: Pick<
    SimpleStreamOptions,
    "temperature" | "maxTokens" | "reasoning"
  >;
}

/** Attributes set on a chat span at request time, before the model has streamed. */
export function chatRequestAttributes(
  model: Model<string>,
  context: Context,
  meta: AgentMeta,
  options?: ChatRequestAttributeOptions,
): Attributes {
  const attributes: Attributes = {
    [GenAi.CONVERSATION_ID]: meta.conversationId,
    [GenAi.AGENT_ID]: meta.agentId,
    [GenAi.AGENT_NAME]: meta.agentName,
    [GenAi.OPERATION_NAME]: "chat",
    [GenAi.PROVIDER_NAME]: semconvProviderName(model.provider),
    [GenAi.REQUEST_MODEL]: model.id,
    "gen_ai.request.stream": true,
    ...serverAttributes(model.baseUrl),
  };

  if (context.systemPrompt) {
    const serialized = serializeWithCap(
      () => JSON.stringify(systemPromptToInstructions(context.systemPrompt!)),
      () => undefined,
      GenAi.SYSTEM_INSTRUCTIONS,
    );
    if (serialized) {
      attributes[GenAi.SYSTEM_INSTRUCTIONS] = serialized;
    }
  }

  const toolDefinitions = serializeToolDefinitions(context.tools);
  if (toolDefinitions) {
    attributes[GenAi.TOOL_DEFINITIONS] = toolDefinitions;
  }

  const inputMessages = messagesToInputMessages(context.messages, options);
  const serializedInput = serializeMessagesWithCap(
    inputMessages,
    GenAi.INPUT_MESSAGES,
  );
  if (serializedInput) {
    attributes[GenAi.INPUT_MESSAGES] = serializedInput;
  }
  if (
    inputMessages.some((message) =>
      message.parts.some((part) => part.type === "compaction"),
    )
  ) {
    attributes["gen_ai.conversation.compacted"] = true;
  }
  if (typeof options?.streamOptions?.temperature === "number") {
    attributes["gen_ai.request.temperature"] =
      options.streamOptions.temperature;
  }
  if (typeof options?.streamOptions?.maxTokens === "number") {
    attributes["gen_ai.request.max_tokens"] = options.streamOptions.maxTokens;
  }
  if (typeof options?.streamOptions?.reasoning === "string") {
    attributes["gen_ai.request.reasoning.level"] =
      options.streamOptions.reasoning;
  }

  return attributes;
}

/**
 * Attributes set on a chat span when the assistant message has settled.
 *
 * Cache usage fields are only set when > 0, matching the OTel semconv
 * convention that an absent attribute means "not reported by provider".
 */
export function chatResponseAttributes(message: AssistantMessage): Attributes {
  const attributes: Attributes = {
    [GenAi.RESPONSE_FINISH_REASONS]: [semconvFinishReason(message.stopReason)],
    // Semconv: input_tokens covers ALL input tokens; cache_read /
    // cache_creation are subsets of it. pi-ai normalizes usage.input to
    // EXCLUDE cache tokens on every provider, so re-add them here.
    [GenAi.USAGE_INPUT_TOKENS]:
      message.usage.input + message.usage.cacheRead + message.usage.cacheWrite,
    [GenAi.USAGE_OUTPUT_TOKENS]: message.usage.output,
  };

  const serializedOutput = serializeMessagesWithCap(
    assistantToOutputMessages(message),
    GenAi.OUTPUT_MESSAGES,
  );
  if (serializedOutput) {
    attributes[GenAi.OUTPUT_MESSAGES] = serializedOutput;
  }

  if (message.usage.cacheRead > 0) {
    attributes[GenAi.USAGE_CACHE_READ_INPUT_TOKENS] = message.usage.cacheRead;
  }
  if (message.usage.cacheWrite > 0) {
    attributes[GenAi.USAGE_CACHE_CREATION_INPUT_TOKENS] =
      message.usage.cacheWrite;
  }
  if (message.usage.cost?.total) {
    attributes[GenAi.COST_USD] = message.usage.cost.total;
  }
  const reasoningOutputTokens =
    (
      message.usage as typeof message.usage & {
        reasoningOutput?: number;
        reasoningOutputTokens?: number;
      }
    ).reasoningOutputTokens ??
    (
      message.usage as typeof message.usage & {
        reasoningOutput?: number;
      }
    ).reasoningOutput;
  if (typeof reasoningOutputTokens === "number" && reasoningOutputTokens > 0) {
    attributes[GenAi.USAGE_REASONING_TOKENS] = reasoningOutputTokens;
  }
  if (message.responseId) {
    attributes[GenAi.RESPONSE_ID] = message.responseId;
  }
  if (message.model) {
    attributes[GenAi.RESPONSE_MODEL] = message.model;
  }

  return attributes;
}

/** Common attributes for an execute_tool span (set at start). */
export function executeToolAttributes(
  toolName: string,
  toolCallId: string,
  args: unknown,
  meta: AgentMeta,
  description?: string,
): Attributes {
  const attributes: Attributes = {
    [GenAi.CONVERSATION_ID]: meta.conversationId,
    [GenAi.AGENT_ID]: meta.agentId,
    [GenAi.AGENT_NAME]: meta.agentName,
    [GenAi.OPERATION_NAME]: "execute_tool",
    [GenAi.TOOL_NAME]: toolName,
    [GenAi.TOOL_TYPE]: "function",
    [GenAi.TOOL_CALL_ID]: toolCallId,
  };
  if (description) {
    attributes[GenAi.TOOL_DESCRIPTION] = description;
  }
  if (args !== undefined) {
    attributes[GenAi.TOOL_CALL_ARGUMENTS] = stringify(args);
  }
  return attributes;
}

/**
 * Attributes for an `invoke_agent` span (set at start).
 *
 * Per the semconv agent-span table for in-process invocation, model and
 * provider are intentionally NOT recorded: pi agents can switch models
 * mid-run, and the spec says `gen_ai.request.model` SHOULD NOT be
 * populated for agents that support dynamic model selection.
 */
export function invokeAgentAttributes(meta: AgentMeta): Attributes {
  return {
    [GenAi.CONVERSATION_ID]: meta.conversationId,
    [GenAi.AGENT_ID]: meta.agentId,
    [GenAi.AGENT_NAME]: meta.agentName,
    [GenAi.OPERATION_NAME]: "invoke_agent",
  };
}

/** Result attribute for an execute_tool span (set at end). */
export function executeToolResultAttribute(result: unknown): Attributes {
  if (result === undefined) return {};
  return { [GenAi.TOOL_CALL_RESULT]: stringify(result) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

function serializeToolDefinitions(
  tools: readonly Tool[] | undefined,
): string | undefined {
  if (!tools || tools.length === 0) return undefined;

  const detailed: ToolDefinition[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));

  return serializeWithCap(
    () => JSON.stringify(detailed.map((def) => ({ type: "function", ...def }))),
    () =>
      JSON.stringify(
        detailed.map((def) => ({ type: "function", name: def.name })),
      ),
    GenAi.TOOL_DEFINITIONS,
  );
}

/**
 * Cap chars per part-content string in the truncation fallback for
 * `gen_ai.input.messages` / `gen_ai.output.messages`. Chosen so even long
 * transcripts stay within MAX_BYTES once every part is clamped.
 */
const MAX_PART_CONTENT_CHARS = 8_000;

/**
 * Serialize an input/output message array under the size cap, per the
 * semconv guidance that instrumentations may truncate individual message
 * contents while preserving JSON structure: full payload first, then a
 * fallback with each part's content clamped, then drop the attribute.
 */
function serializeMessagesWithCap(
  messages: readonly (InputMessage | OutputMessage)[],
  attributeName: string,
): string | undefined {
  return serializeWithCap(
    () => JSON.stringify(messages),
    () => JSON.stringify(messages.map(truncateMessageParts)),
    attributeName,
  );
}

function truncateMessageParts<T extends InputMessage | OutputMessage>(
  message: T,
): T {
  return {
    ...message,
    parts: message.parts.map((part) => {
      const truncated: Record<string, unknown> = { ...part };
      for (const key of ["content", "response"]) {
        const value = truncated[key];
        if (
          typeof value === "string" &&
          value.length > MAX_PART_CONTENT_CHARS
        ) {
          truncated[key] =
            value.slice(0, MAX_PART_CONTENT_CHARS) + "…[truncated]";
        }
      }
      return truncated as unknown as typeof part;
    }),
  };
}

/**
 * Try the detailed serializer; if it exceeds the cap, try a compact fallback;
 * if that still exceeds, drop the attribute (returns undefined).
 */
function serializeWithCap(
  detailed: () => string,
  compact: () => string | undefined,
  attributeName: string,
): string | undefined {
  const fullPayload = detailed();
  if (byteLength(fullPayload) <= MAX_BYTES) {
    return fullPayload;
  }

  const compactPayload = compact();
  if (compactPayload && byteLength(compactPayload) <= MAX_BYTES) {
    console.warn(
      `[introspection-pi] Compacting oversized ${attributeName} (${byteLength(fullPayload)} bytes)`,
    );
    return compactPayload;
  }

  console.warn(
    `[introspection-pi] Dropping oversized ${attributeName} (${byteLength(fullPayload)} bytes)`,
  );
  return undefined;
}

function byteLength(value: string): number {
  if (typeof Buffer !== "undefined") {
    return Buffer.byteLength(value);
  }
  return new TextEncoder().encode(value).length;
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
