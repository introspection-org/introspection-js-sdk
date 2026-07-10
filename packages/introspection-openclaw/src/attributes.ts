/**
 * Pure builders that turn OpenClaw event payloads into OTel `Attributes`
 * records, ready for `span.setAttributes(...)`.
 *
 * Mirrors the `attributes.ts` layer in `@introspection-sdk/introspection-pi`:
 * keeps `hooks.ts` short and free of inline string keys.
 */

import type { Attributes } from "@opentelemetry/api";
import {
  GenAi,
  type InputMessage,
  type OutputMessage,
  type SystemInstruction,
  type ToolDefinition,
} from "@introspection-sdk/types";
import { prepareForCapture, safeJsonStringify } from "./util.js";

/** Maximum byte size for any single semconv JSON attribute. */
export const MAX_BYTES = 64_000;

/** Identifies the agent owning a span. */
export interface AgentMeta {
  agentId: string;
  agentName: string;
  conversationId: string;
}

/** Token usage delta as emitted by an OpenClaw `llm_output` event. */
export interface UsageDelta {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

// ─── invoke_agent ──────────────────────────────────────────────────────────

export function invokeAgentAttributes(
  meta: AgentMeta,
  sessionKey: string,
): Attributes {
  return {
    [GenAi.OPERATION_NAME]: "invoke_agent",
    [GenAi.AGENT_ID]: meta.agentId,
    [GenAi.AGENT_NAME]: meta.agentName,
    [GenAi.CONVERSATION_ID]: meta.conversationId,
    "openclaw.session_key": sessionKey,
  };
}

// ─── chat request ──────────────────────────────────────────────────────────

export interface ChatRequestInput {
  agentName: string;
  provider: string;
  model: string;
  runId: string;
  imagesCount?: number;
  systemPrompt?: string;
  toolDefinitions?: ToolDefinition[];
  inputMessages?: InputMessage[];
}

export function chatRequestAttributes(input: ChatRequestInput): Attributes {
  const attrs: Attributes = {
    [GenAi.OPERATION_NAME]: "chat",
    [GenAi.AGENT_NAME]: input.agentName,
    [GenAi.PROVIDER_NAME]: input.provider,
    [GenAi.REQUEST_MODEL]: input.model,
    "openclaw.llm.run_id": input.runId,
  };

  if (typeof input.imagesCount === "number") {
    attrs["openclaw.llm.images_count"] = input.imagesCount;
  }

  const tools = serializeToolDefinitions(input.toolDefinitions);
  if (tools) attrs[GenAi.TOOL_DEFINITIONS] = tools;

  const sys = serializeSystemInstructions(input.systemPrompt);
  if (sys) attrs[GenAi.SYSTEM_INSTRUCTIONS] = sys;

  const messages = serializeBounded(input.inputMessages);
  if (messages && input.inputMessages?.length) {
    attrs[GenAi.INPUT_MESSAGES] = messages;
    // OpenClaw-specific: index range covering "messages added this turn".
    // The current prompt is appended last by `convertInputMessages`, so the
    // new range is always `[length - 1, length]`.
    const end = input.inputMessages.length;
    attrs["introspection.new_messages.start"] = end - 1;
    attrs["introspection.new_messages.end"] = end;
  }

  return attrs;
}

// ─── chat response ─────────────────────────────────────────────────────────

export interface ChatResponseInput {
  responseModel: string;
  usage?: UsageDelta;
  finishReason?: string;
  costUsd?: number;
  outputMessages?: OutputMessage[];
}

export function chatResponseAttributes(input: ChatResponseInput): Attributes {
  const attrs: Attributes = {
    [GenAi.RESPONSE_MODEL]: input.responseModel,
    ...usageAttributes(input.usage),
  };

  if (input.finishReason) {
    attrs[GenAi.RESPONSE_FINISH_REASONS] = [input.finishReason];
  }
  if (typeof input.costUsd === "number") {
    attrs[GenAi.COST_USD] = input.costUsd;
  }
  const out = serializeBounded(input.outputMessages);
  if (out) attrs[GenAi.OUTPUT_MESSAGES] = out;

  return attrs;
}

/**
 * Attributes for the **second** chat span emitted in a tool-using turn —
 * `input` is the synthesised tool-result message list, `output` is the
 * final assistant text. Mirrors `chatRequestAttributes` + `chatResponseAttributes`
 * but on a single span.
 */
export interface ToolResponseChatInput extends ChatResponseInput {
  agentName: string;
  provider: string;
  requestModel: string;
  inputMessages: InputMessage[];
}

export function toolResponseChatAttributes(
  input: ToolResponseChatInput,
): Attributes {
  const attrs: Attributes = {
    [GenAi.OPERATION_NAME]: "chat",
    [GenAi.AGENT_NAME]: input.agentName,
    [GenAi.PROVIDER_NAME]: input.provider,
    [GenAi.REQUEST_MODEL]: input.requestModel,
    [GenAi.RESPONSE_MODEL]: input.responseModel,
    [GenAi.INPUT_MESSAGES]: JSON.stringify(input.inputMessages),
    "introspection.new_messages.start": 0,
    "introspection.new_messages.end": input.inputMessages.length,
    ...usageAttributes(input.usage),
  };

  if (input.finishReason) {
    attrs[GenAi.RESPONSE_FINISH_REASONS] = [input.finishReason];
  }
  const out = serializeBounded(input.outputMessages);
  if (out) attrs[GenAi.OUTPUT_MESSAGES] = out;

  return attrs;
}

// ─── execute_tool ──────────────────────────────────────────────────────────

export interface ExecuteToolInput {
  toolName: string;
  sequence: number;
  /** Raw tool params; serialized + truncated to `maxCaptureLength` if `captureToolInput` is on. */
  params?: unknown;
  captureToolInput: boolean;
  maxCaptureLength: number;
}

export function executeToolAttributes(input: ExecuteToolInput): Attributes {
  const attrs: Attributes = {
    [GenAi.OPERATION_NAME]: "execute_tool",
    [GenAi.TOOL_NAME]: input.toolName,
    [GenAi.TOOL_TYPE]: "function",
    "openclaw.tool.sequence": input.sequence,
  };

  if (input.params !== undefined) {
    attrs["openclaw.tool.input_size"] = safeJsonStringify(input.params).length;
    if (input.captureToolInput) {
      attrs[GenAi.TOOL_CALL_ARGUMENTS] = prepareForCapture(
        input.params,
        input.maxCaptureLength,
      );
    }
  }

  return attrs;
}

export interface ExecuteToolResultInput {
  durationMs: number;
  message?: unknown;
  captureToolOutput: boolean;
  maxCaptureLength: number;
}

export function executeToolResultAttributes(
  input: ExecuteToolResultInput,
): Attributes {
  const attrs: Attributes = {
    "openclaw.tool.duration_ms": input.durationMs,
  };

  if (input.message !== undefined) {
    const str =
      typeof input.message === "string"
        ? input.message
        : safeJsonStringify(input.message);
    attrs["openclaw.tool.output_size"] = str.length;
    if (input.captureToolOutput) {
      attrs[GenAi.TOOL_CALL_RESULT] = prepareForCapture(
        input.message,
        input.maxCaptureLength,
      );
    }
  }

  return attrs;
}

// ─── invoke_agent finalisation ─────────────────────────────────────────────

export interface AgentEndInput {
  durationMs: number;
  toolCount: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  model?: string;
  provider?: string;
}

export function agentEndAttributes(input: AgentEndInput): Attributes {
  const attrs: Attributes = {
    "openclaw.request.duration_ms": input.durationMs,
    "openclaw.request.tool_count": input.toolCount,
  };

  if (input.tokens.input > 0 || input.tokens.output > 0) {
    attrs[GenAi.USAGE_INPUT_TOKENS] = input.tokens.input;
    attrs[GenAi.USAGE_OUTPUT_TOKENS] = input.tokens.output;
  }
  if (input.tokens.cacheRead > 0) {
    attrs["openclaw.usage.cache_read_tokens"] = input.tokens.cacheRead;
  }
  if (input.tokens.cacheWrite > 0) {
    attrs["openclaw.usage.cache_write_tokens"] = input.tokens.cacheWrite;
  }

  if (input.model) {
    attrs[GenAi.REQUEST_MODEL] = input.model;
    attrs[GenAi.RESPONSE_MODEL] = input.model;
  }
  if (input.provider) {
    attrs[GenAi.PROVIDER_NAME] = input.provider;
  }

  return attrs;
}

// ─── usage ─────────────────────────────────────────────────────────────────

/**
 * Build per-call usage attributes from an `llm_output` event.
 *
 * Emits the spec-correct `gen_ai.usage.cache_read.input_tokens` /
 * `cache_creation.input_tokens` keys. Also mirrors cache deltas onto the
 * legacy `openclaw.usage.cache_*_tokens` keys for backwards compatibility
 * with consumers that have not yet migrated.
 */
export function usageAttributes(usage: UsageDelta | undefined): Attributes {
  if (!usage) return {};
  const attrs: Attributes = {};

  if (typeof usage.input === "number") {
    attrs[GenAi.USAGE_INPUT_TOKENS] = usage.input;
  }
  if (typeof usage.output === "number") {
    attrs[GenAi.USAGE_OUTPUT_TOKENS] = usage.output;
  }
  if (typeof usage.cacheRead === "number") {
    attrs[GenAi.USAGE_CACHE_READ_INPUT_TOKENS] = usage.cacheRead;
    attrs["openclaw.usage.cache_read_tokens"] = usage.cacheRead;
  }
  if (typeof usage.cacheWrite === "number") {
    attrs[GenAi.USAGE_CACHE_CREATION_INPUT_TOKENS] = usage.cacheWrite;
    attrs["openclaw.usage.cache_write_tokens"] = usage.cacheWrite;
  }

  return attrs;
}

// ─── helpers ───────────────────────────────────────────────────────────────

function serializeBounded(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const json = JSON.stringify(value);
  return byteLength(json) > MAX_BYTES ? undefined : json;
}

function serializeSystemInstructions(
  prompt: string | undefined,
): string | undefined {
  if (!prompt) return undefined;
  const wrapped: SystemInstruction[] = [{ type: "text", content: prompt }];
  return serializeBounded(wrapped);
}

function serializeToolDefinitions(
  tools: ToolDefinition[] | undefined,
): string | undefined {
  if (!tools?.length) return undefined;
  const detailed = serializeBounded(tools);
  if (detailed) return detailed;
  // Compact fallback — drop description / parameters and try again.
  return serializeBounded(tools.map((t) => ({ type: t.type, name: t.name })));
}

function byteLength(s: string): number {
  return typeof Buffer !== "undefined"
    ? Buffer.byteLength(s)
    : new TextEncoder().encode(s).length;
}
