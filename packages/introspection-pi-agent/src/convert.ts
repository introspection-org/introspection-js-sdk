/**
 * Pure converters between strongly-typed pi-ai messages and the OTEL GenAI
 * semantic-convention JSON shapes from `@introspection-sdk/types`.
 *
 * No OTel runtime dependency — these functions only return plain values, so
 * they can be unit-tested without a tracer or span context.
 */

import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@mariozechner/pi-ai";
import type {
  InputMessage,
  MessagePart,
  OutputMessage,
  ReasoningPart,
  SystemInstruction,
  TextPart,
  ToolCallRequestPart,
  ToolCallResponsePart,
} from "@introspection-sdk/types";

// ─────────────────────────────────────────────────────────────────────────────
// pi-ai → semconv
// ─────────────────────────────────────────────────────────────────────────────

/** Convert a `Message[]` (pi-ai source) to the `gen_ai.input.messages` shape. */
export function messagesToInputMessages(
  messages: readonly Message[],
): InputMessage[] {
  const result: InputMessage[] = [];
  for (const message of messages) {
    const converted = messageToSemconv(message);
    if (converted) result.push(converted);
  }
  return result;
}

/** Convert an `AssistantMessage` to the `gen_ai.output.messages` shape. */
export function assistantToOutputMessages(
  message: AssistantMessage,
): OutputMessage[] {
  const semconv = assistantMessageToSemconv(message);
  return [outputMessageFromSemconv(semconv, message)];
}

/** Wrap a system prompt in the semconv shape used for `gen_ai.system_instructions`. */
export function systemPromptToInstructions(
  systemPrompt: string,
): SystemInstruction[] {
  return [{ type: "text", content: systemPrompt }];
}

function messageToSemconv(message: Message): InputMessage | null {
  switch (message.role) {
    case "user":
      return userMessageToSemconv(message);
    case "assistant": {
      const semconv = assistantMessageToSemconv(message);
      // For input messages we include the assistant message as-is (no
      // finish_reason / response_id metadata at the input layer).
      return { role: "assistant", parts: semconv.parts };
    }
    case "toolResult":
      return toolResultToSemconv(message);
  }
}

function userMessageToSemconv(message: UserMessage): InputMessage {
  const text =
    typeof message.content === "string"
      ? message.content
      : extractTextFromUserContent(message.content);
  return {
    role: "user",
    parts: [{ type: "text", content: text }],
  };
}

interface SemconvAssistant {
  parts: MessagePart[];
  finish_reason?: string;
  api?: string;
  provider?: string;
  model?: string;
  response_id?: string;
}

function assistantMessageToSemconv(
  message: AssistantMessage,
): SemconvAssistant {
  const parts: MessagePart[] = [];
  for (const block of message.content) {
    const part = assistantBlockToPart(block);
    if (part) parts.push(part);
  }

  const result: SemconvAssistant = { parts };
  if (message.stopReason) result.finish_reason = message.stopReason;
  if (message.api) result.api = message.api;
  if (message.provider) result.provider = message.provider;
  if (message.model) result.model = message.model;
  if (message.responseId) result.response_id = message.responseId;
  return result;
}

function outputMessageFromSemconv(
  semconv: SemconvAssistant,
  source: AssistantMessage,
): OutputMessage {
  const result: OutputMessage = { role: "assistant", parts: semconv.parts };
  if (semconv.finish_reason) result.finish_reason = semconv.finish_reason;
  if (semconv.api) result.api = semconv.api;
  if (semconv.provider ?? source.provider) {
    result.provider = semconv.provider ?? source.provider;
  }
  if (semconv.model ?? source.model) {
    result.model = semconv.model ?? source.model;
  }
  if (semconv.response_id ?? source.responseId) {
    result.response_id = semconv.response_id ?? source.responseId;
  }
  return result;
}

function toolResultToSemconv(message: ToolResultMessage): InputMessage {
  return {
    role: "tool",
    name: message.toolName,
    parts: [
      {
        type: "tool_call_response",
        id: message.toolCallId,
        name: message.toolName,
        response: extractToolResultText(message.content),
      },
    ],
  };
}

function assistantBlockToPart(
  block: TextContent | ThinkingContent | ToolCall,
): MessagePart | null {
  switch (block.type) {
    case "text": {
      if (!block.text) return null;
      const part: TextPart = { type: "text", content: block.text };
      if (block.textSignature) {
        part.text_signature = block.textSignature;
      }
      return part;
    }
    case "thinking": {
      if (!block.thinking && !block.thinkingSignature) return null;
      const part: ReasoningPart = {
        type: "thinking",
        content: block.thinking ?? "",
      };
      if (block.thinkingSignature) {
        part.signature = block.thinkingSignature;
      }
      if (block.redacted) {
        part.redacted = true;
      }
      return part;
    }
    case "toolCall": {
      const part: ToolCallRequestPart = {
        type: "tool_call",
        name: block.name,
        id: block.id,
        arguments: block.arguments,
      };
      return part;
    }
  }
}

function extractTextFromUserContent(
  blocks: readonly (TextContent | ImageContent)[],
): string {
  return blocks
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("");
}

function extractToolResultText(content: ToolResultMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => (block.type === "text" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// semconv → pi-ai
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hydrate an array of semconv messages back into pi-ai `Message[]`.
 *
 * - Drops messages whose `parts` are empty.
 * - Resolves a `tool_call_response` `name` from a preceding assistant
 *   `tool_call` part if absent.
 * - Drops orphaned tool results — sending them back to a model would
 *   break the assistant→tool_result pairing the providers expect.
 * - Strips trailing assistant `tool_call` blocks that never received a
 *   matching tool result (e.g. an aborted turn).
 */
export function inputMessagesToMessages(
  messages: readonly InputMessage[],
): Message[] {
  if (messages.length === 0) return [];

  const result: Message[] = [];
  const toolNameById = new Map<string, string>();

  for (const message of messages) {
    const parts = message.parts ?? [];

    if (message.role === "user") {
      const text = parts
        .filter(isTextPart)
        .map((part) => part.content)
        .join("");
      if (!text) continue;
      result.push({ role: "user", content: text, timestamp: 0 });
      continue;
    }

    if (message.role === "assistant") {
      const content: (TextContent | ThinkingContent | ToolCall)[] = [];
      for (const part of parts) {
        const block = partToAssistantBlock(part, toolNameById);
        if (block) content.push(block);
      }
      if (content.length === 0) continue;
      result.push({
        role: "assistant",
        content,
        api: "anthropic-messages",
        provider: "anthropic",
        model: "",
        usage: emptyUsage(),
        stopReason: "stop",
        timestamp: 0,
      });
      continue;
    }

    if (message.role === "tool") {
      for (const part of parts) {
        if (!isToolCallResponsePart(part)) continue;
        const id = part.id ?? "";
        const toolName =
          part.name ?? message.name ?? toolNameById.get(id) ?? "";
        if (!id || !toolName) continue;
        result.push({
          role: "toolResult",
          toolCallId: id,
          toolName,
          content: [{ type: "text", text: stringifyToolResult(part.response) }],
          isError: false,
          timestamp: 0,
        });
      }
    }
  }

  return sanitizeToolPairing(result);
}

function partToAssistantBlock(
  part: MessagePart,
  toolNameById: Map<string, string>,
): TextContent | ThinkingContent | ToolCall | null {
  if (isTextPart(part)) {
    if (!part.content) return null;
    const block: TextContent = { type: "text", text: part.content };
    if (part.text_signature) block.textSignature = part.text_signature;
    return block;
  }
  if (isReasoningPart(part)) {
    if (!part.content && !part.signature) return null;
    const block: ThinkingContent = {
      type: "thinking",
      thinking: part.content ?? "",
    };
    if (part.signature) block.thinkingSignature = part.signature;
    if (part.redacted) block.redacted = true;
    return block;
  }
  if (isToolCallRequestPart(part)) {
    if (part.id && part.name) {
      toolNameById.set(part.id, part.name);
    }
    return {
      type: "toolCall",
      id: part.id ?? "",
      name: part.name,
      arguments: parseToolArguments(part.arguments),
    };
  }
  return null;
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  return {};
}

function stringifyToolResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  return JSON.stringify(value);
}

function emptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function sanitizeToolPairing(messages: readonly Message[]): Message[] {
  const result: Message[] = [];
  let activeToolCallIds = new Set<string>();

  for (const message of messages) {
    if (message.role === "assistant") {
      activeToolCallIds = new Set();
      for (const block of message.content) {
        if (block.type === "toolCall" && block.id) {
          activeToolCallIds.add(block.id);
        }
      }
      result.push(message);
      continue;
    }

    if (message.role === "toolResult") {
      if (activeToolCallIds.has(message.toolCallId)) {
        activeToolCallIds.delete(message.toolCallId);
        result.push(message);
      }
      continue;
    }

    activeToolCallIds = new Set();
    result.push(message);
  }

  if (activeToolCallIds.size === 0 || result.length === 0) {
    return result;
  }

  for (let i = result.length - 1; i >= 0; i -= 1) {
    const message = result[i];
    if (!message || message.role !== "assistant") continue;
    const cleanedContent = message.content.filter(
      (block) =>
        !(
          block.type === "toolCall" &&
          block.id &&
          activeToolCallIds.has(block.id)
        ),
    );
    if (cleanedContent.length === 0) {
      result.splice(i, 1);
    } else if (cleanedContent.length !== message.content.length) {
      result[i] = { ...message, content: cleanedContent };
    }
    break;
  }

  return result;
}

function isTextPart(part: MessagePart): part is TextPart {
  return part.type === "text";
}

function isReasoningPart(part: MessagePart): part is ReasoningPart {
  return part.type === "thinking";
}

function isToolCallRequestPart(part: MessagePart): part is ToolCallRequestPart {
  return part.type === "tool_call";
}

function isToolCallResponsePart(
  part: MessagePart,
): part is ToolCallResponsePart {
  return part.type === "tool_call_response";
}
