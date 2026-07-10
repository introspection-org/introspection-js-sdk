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
} from "@earendil-works/pi-ai";
import type {
  BlobPart,
  CompactionPart,
  InputMessage,
  MessagePart,
  OutputMessage,
  ReasoningPart,
  SystemInstruction,
  TextPart,
  ToolCallRequestPart,
  ToolCallResponsePart,
} from "@introspection-sdk/types";

/**
 * Pi renders a compaction summary into model-visible context as a user
 * message wrapping the summary in this prose preamble + `<summary>` tags
 * (`COMPACTION_SUMMARY_PREFIX` / `COMPACTION_SUMMARY_SUFFIX` in
 * `@earendil-works/pi-coding-agent`'s `core/messages.ts` — not exported,
 * so mirrored here). This is only the FALLBACK detection path for callers
 * that cannot supply {@link ConvertOptions.compactionSummaries}; the
 * contract test in `tests/converters/pi.test.ts` pins these against pi's
 * real `convertToLlm` output, so a rewording in pi fails the SDK tests
 * instead of silently breaking the fallback.
 */
const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;

const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;

/** Options for the pi-ai → semconv conversion. */
export interface ConvertOptions {
  /**
   * Known compaction summaries for the session, sourced structurally from
   * pi's session tree (`session.sessionManager.getEntries()` →
   * `type === "compaction"` → `summary`). A user message containing one of these verbatim is
   * emitted as a `compaction` part with that summary as content,
   * regardless of the prose wrapper pi rendered around it — so this path
   * keeps working if pi rewords its preamble or an extension customizes
   * compaction. When absent (or nothing matches), detection falls back to
   * the mirrored prefix/suffix sniff above.
   */
  compactionSummaries?: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// pi-ai → semconv
// ─────────────────────────────────────────────────────────────────────────────

/** Convert a `Message[]` (pi-ai source) to the `gen_ai.input.messages` shape. */
export function messagesToInputMessages(
  messages: readonly Message[],
  options?: ConvertOptions,
): InputMessage[] {
  const result: InputMessage[] = [];
  for (const message of messages) {
    const converted = messageToSemconv(message, options);
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

/**
 * Map a pi-ai stop reason to the semconv `FinishReason` value
 * (gen-ai-output-messages.json). Only `"toolUse"` needs translation — the
 * schema enum calls it `"tool_call"`. The remaining pi values are either
 * enum members already (`stop`, `length`, `error`) or intentionally kept
 * as custom strings (`aborted`; the schema allows free-form values).
 */
export function semconvFinishReason(stopReason: string): string {
  return stopReason === "toolUse" ? "tool_call" : stopReason;
}

function messageToSemconv(
  message: Message,
  options?: ConvertOptions,
): InputMessage | null {
  switch (message.role) {
    case "user":
      return userMessageToSemconv(message, options);
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

function userMessageToSemconv(
  message: UserMessage,
  options?: ConvertOptions,
): InputMessage {
  const text =
    typeof message.content === "string"
      ? message.content
      : extractTextFromUserContent(message.content);
  const summary = matchCompactionSummary(text, options);
  if (summary !== null) {
    return {
      role: "user",
      parts: [{ type: "compaction", content: summary }],
    };
  }
  if (typeof message.content === "string") {
    return {
      role: "user",
      parts: [{ type: "text", content: message.content }],
    };
  }
  // Block-array content: preserve part order, including images. Image
  // payloads (base64) are intentionally omitted — only the modality and
  // MIME type are recorded, keeping attribute sizes bounded while the
  // message structure stays visible.
  const parts: MessagePart[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      if (block.text) parts.push({ type: "text", content: block.text });
    } else {
      const blob: BlobPart = { type: "blob", modality: "image" };
      if (block.mimeType) blob.mime_type = block.mimeType;
      parts.push(blob);
    }
  }
  if (parts.length === 0) {
    parts.push({ type: "text", content: "" });
  }
  return { role: "user", parts };
}

/**
 * Identify a user message as a rendered compaction summary.
 *
 * Primary path: the text contains a session-known summary verbatim
 * (wrapper-agnostic — see {@link ConvertOptions.compactionSummaries}).
 * Fallback: the text is wrapped in pi's default preamble + `<summary>`
 * tags, anchored on both ends so a user message merely quoting the
 * preamble somewhere in its body is never rewritten.
 *
 * Returns the summary content, or null when the message is not a
 * compaction rendering.
 */
function matchCompactionSummary(
  text: string,
  options?: ConvertOptions,
): string | null {
  for (const summary of options?.compactionSummaries ?? []) {
    if (summary && text.includes(summary)) return summary;
  }
  if (
    text.startsWith(COMPACTION_SUMMARY_PREFIX) &&
    text.endsWith(COMPACTION_SUMMARY_SUFFIX)
  ) {
    return text.slice(
      COMPACTION_SUMMARY_PREFIX.length,
      text.length - COMPACTION_SUMMARY_SUFFIX.length,
    );
  }
  return null;
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
  if (message.stopReason) {
    result.finish_reason = semconvFinishReason(message.stopReason);
  }
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
        type: "reasoning",
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
      // Compaction parts are re-rendered into the exact prefixed text Pi
      // originally sent to the model, so hydrated history is byte-identical.
      const text = parts
        .map((part) =>
          isTextPart(part)
            ? part.content
            : isCompactionPart(part)
              ? COMPACTION_SUMMARY_PREFIX +
                part.content +
                COMPACTION_SUMMARY_SUFFIX
              : "",
        )
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

function isCompactionPart(part: MessagePart): part is CompactionPart {
  return part.type === "compaction";
}

function isReasoningPart(part: MessagePart): part is ReasoningPart {
  // "reasoning" is the semconv discriminator; "thinking" is the legacy
  // value this package emitted before — keep hydrating stored spans that
  // used it.
  return part.type === "reasoning" || part.type === "thinking";
}

function isToolCallRequestPart(part: MessagePart): part is ToolCallRequestPart {
  return part.type === "tool_call";
}

function isToolCallResponsePart(
  part: MessagePart,
): part is ToolCallResponsePart {
  return part.type === "tool_call_response";
}
