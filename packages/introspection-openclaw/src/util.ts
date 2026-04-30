/**
 * OpenClaw → OTel GenAI semantic-convention conversion + small JSON helpers.
 *
 * Output shapes come from `@introspection-sdk/types` so this plugin,
 * `introspection-node`, and `introspection-pi-agent` all emit identical
 * `gen_ai.input.messages` / `gen_ai.output.messages` JSON.
 */

import type {
  InputMessage,
  MessagePart,
  OutputMessage,
  ToolCallRequestPart,
} from "@introspection-sdk/types";

// ─── JSON helpers ──────────────────────────────────────────────────────────

/** JSON.stringify with circular-ref + BigInt fallbacks. */
export function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, val) => {
      if (typeof val === "bigint") return val.toString();
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    });
  } catch {
    return String(value);
  }
}

/** Truncate a string with a `...[truncated]` suffix when it exceeds `maxLength`. */
export function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength)}...[truncated]`;
}

/** Stringify (if needed) and truncate — for capturing values as span attributes. */
export function prepareForCapture(value: unknown, maxLength: number): string {
  const str = typeof value === "string" ? value : safeJsonStringify(value);
  return truncate(str, maxLength);
}

// ─── OpenClaw → semconv conversion ─────────────────────────────────────────

/**
 * Convert one OpenClaw content block to a semconv message part.
 *
 *  OpenClaw                                  → semconv
 *  ──────────                                  ──────────
 *  {type:"text", text}                       → {type:"text", content}
 *  {type:"thinking", thinking}               → {type:"text", content}
 *  {type:"tool_use", name, id, arguments}    → {type:"tool_call", ...}
 *
 * Returns `null` for blocks that have no representable content.
 */
function convertPart(block: Record<string, unknown>): MessagePart | null {
  switch (block.type) {
    case "text":
      return { type: "text", content: (block.text as string) ?? "" };

    case "thinking": {
      const thinking = block.thinking as string | undefined;
      return thinking ? { type: "text", content: thinking } : null;
    }

    case "tool_use": {
      const part: ToolCallRequestPart = {
        type: "tool_call",
        name: block.name as string,
      };
      if (typeof block.id === "string") part.id = block.id;
      // OpenClaw uses `arguments`; older versions used `input`.
      const args = block.arguments ?? block.input;
      if (args !== undefined) part.arguments = args;
      return part;
    }

    default:
      // Last-resort text extraction for unknown shapes.
      return typeof block.text === "string"
        ? { type: "text", content: block.text }
        : null;
  }
}

/** Convert an OpenClaw content array (or plain string) to semconv parts. */
function partsOf(content: unknown): MessagePart[] {
  if (typeof content === "string") return [{ type: "text", content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const part = convertPart(item as Record<string, unknown>);
    return part ? [part] : [];
  });
}

/**
 * Convert OpenClaw history messages + the current user prompt to semconv
 * `gen_ai.input.messages` form.
 *
 * Roles map: `"user"` → `"user"`, `"assistant"` → `"assistant"`,
 * `"toolResult"` → `"tool"`.
 */
export function convertInputMessages(
  historyMessages: unknown[],
  currentPrompt?: unknown,
): InputMessage[] {
  const result: InputMessage[] = [];

  for (const raw of historyMessages) {
    if (typeof raw !== "object" || raw === null) continue;
    const msg = raw as Record<string, unknown>;

    switch (msg.role) {
      case "user":
      case "assistant":
        result.push({ role: msg.role, parts: partsOf(msg.content) });
        break;

      case "toolResult":
        result.push(toolResultMessage(msg));
        break;
    }
  }

  if (currentPrompt !== undefined) {
    const promptStr =
      typeof currentPrompt === "string"
        ? currentPrompt
        : safeJsonStringify(currentPrompt);
    result.push({
      role: "user",
      parts: [{ type: "text", content: promptStr }],
    });
  }

  return result;
}

/** Convert an OpenClaw `toolResult` history entry to a semconv `tool` message. */
function toolResultMessage(msg: Record<string, unknown>): InputMessage {
  const toolCallId =
    typeof msg.toolCallId === "string" ? msg.toolCallId : undefined;
  const parts: MessagePart[] = [];

  const append = (response: unknown) => {
    parts.push({
      type: "tool_call_response",
      response,
      ...(toolCallId && { id: toolCallId }),
    });
  };

  if (typeof msg.content === "string") {
    append(msg.content);
  } else if (Array.isArray(msg.content)) {
    for (const item of msg.content) {
      if (
        typeof item === "object" &&
        item !== null &&
        (item as { type?: unknown }).type === "text"
      ) {
        append((item as { text?: unknown }).text);
      }
    }
  }

  return {
    role: "tool",
    parts,
    ...(typeof msg.toolName === "string" && { name: msg.toolName }),
  };
}

/**
 * Convert an OpenClaw `lastAssistant` payload to semconv `gen_ai.output.messages` form.
 *
 * Accepts the structured object form, a bare string, or anything else (returns `[]`).
 */
export function convertOutputMessages(lastAssistant: unknown): OutputMessage[] {
  if (typeof lastAssistant === "string") {
    return [
      { role: "assistant", parts: [{ type: "text", content: lastAssistant }] },
    ];
  }
  if (typeof lastAssistant !== "object" || lastAssistant === null) return [];

  const msg = lastAssistant as Record<string, unknown>;
  const out: OutputMessage = { role: "assistant", parts: partsOf(msg.content) };
  if (typeof msg.stopReason === "string") out.finish_reason = msg.stopReason;
  return [out];
}
