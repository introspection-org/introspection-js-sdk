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
  Tool,
} from "@earendil-works/pi-ai";
import { GenAi, type ToolDefinition } from "@introspection-sdk/types";
import {
  assistantToOutputMessages,
  messagesToInputMessages,
  systemPromptToInstructions,
  type ConvertOptions,
} from "./convert.js";

const MAX_BYTES = 64_000;

/** Metadata that the consumer attaches to every chat / tool span. */
export interface AgentMeta {
  conversationId: string;
  agentId: string;
  agentName: string;
}

/** Attributes set on a chat span at request time, before the model has streamed. */
export function chatRequestAttributes(
  model: Model<string>,
  context: Context,
  meta: AgentMeta,
  options?: ConvertOptions,
): Attributes {
  const attributes: Attributes = {
    [GenAi.CONVERSATION_ID]: meta.conversationId,
    [GenAi.AGENT_ID]: meta.agentId,
    [GenAi.AGENT_NAME]: meta.agentName,
    [GenAi.OPERATION_NAME]: "chat",
    [GenAi.PROVIDER_NAME]: model.provider,
    [GenAi.REQUEST_MODEL]: model.id,
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

  attributes[GenAi.INPUT_MESSAGES] = JSON.stringify(
    messagesToInputMessages(context.messages, options),
  );

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
    [GenAi.OUTPUT_MESSAGES]: JSON.stringify(assistantToOutputMessages(message)),
    [GenAi.RESPONSE_FINISH_REASONS]: [message.stopReason],
    [GenAi.USAGE_INPUT_TOKENS]: message.usage.input,
    [GenAi.USAGE_OUTPUT_TOKENS]: message.usage.output,
  };

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
  if (args !== undefined) {
    attributes[GenAi.TOOL_CALL_ARGUMENTS] = stringify(args);
  }
  return attributes;
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
