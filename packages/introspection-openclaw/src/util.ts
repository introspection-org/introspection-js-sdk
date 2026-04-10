/**
 * Serialize a value to JSON, handling circular refs and BigInts.
 */
export function safeJsonStringify(value: unknown): string {
  const seen = new WeakSet();
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

/** Truncate a string, appending "...[truncated]" if needed. */
export function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength) + "...[truncated]";
}

/**
 * Prepare a value for recording as a span attribute.
 * Serializes to JSON string and truncates.
 */
export function prepareForCapture(value: unknown, maxLength: number): string {
  const str = typeof value === "string" ? value : safeJsonStringify(value);
  return truncate(str, maxLength);
}

// ---------- OTEL Gen AI semantic convention message conversion ----------

/**
 * OTEL Gen AI semantic convention message part.
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */
interface OtelPart {
  type: "text" | "tool_call" | "tool_call_response";
  content?: string;
  name?: string;
  id?: string;
  arguments?: unknown;
  response?: unknown;
}

interface OtelInputMessage {
  role: "system" | "user" | "assistant" | "tool";
  parts: OtelPart[];
  name?: string;
}

interface OtelOutputMessage {
  role: "system" | "user" | "assistant" | "tool";
  parts: OtelPart[];
  finish_reason?: string;
}

/**
 * Convert an OpenClaw content part to an OTEL semantic convention part.
 *
 * OpenClaw format:
 *   {type: "text", text: "..."}
 *   {type: "thinking", thinking: "..."}
 *   {type: "tool_use", name: "...", arguments: {...}, id: "..."}
 *
 * OTEL format:
 *   {type: "text", content: "..."}
 *   {type: "tool_call", name: "...", arguments: {...}, id: "..."}
 */
function convertPart(part: Record<string, unknown>): OtelPart | null {
  const type = part.type as string;

  if (type === "text") {
    return { type: "text", content: (part.text as string) || "" };
  }

  if (type === "thinking") {
    // Include thinking content as text with a marker
    const thinking = part.thinking as string;
    if (thinking) {
      return { type: "text", content: thinking };
    }
    return null;
  }

  if (type === "tool_use") {
    const result: OtelPart = {
      type: "tool_call",
      name: part.name as string,
    };
    if (part.id) result.id = part.id as string;
    if (part.arguments !== undefined) result.arguments = part.arguments;
    // Some OpenClaw versions use "input" instead of "arguments"
    if (part.input !== undefined && part.arguments === undefined)
      result.arguments = part.input;
    return result;
  }

  // Fallback: treat unknown types as text if they have text content
  if (part.text) {
    return { type: "text", content: part.text as string };
  }

  return null;
}

/**
 * Convert OpenClaw content array to OTEL parts array.
 */
function convertContentToParts(content: unknown): OtelPart[] {
  if (!Array.isArray(content)) {
    // Plain string content
    if (typeof content === "string") {
      return [{ type: "text", content }];
    }
    return [];
  }

  const parts: OtelPart[] = [];
  for (const item of content) {
    if (typeof item === "object" && item !== null) {
      const converted = convertPart(item as Record<string, unknown>);
      if (converted) parts.push(converted);
    }
  }
  return parts;
}

/**
 * Convert an array of OpenClaw history messages to OTEL Gen AI
 * semantic convention input messages format.
 *
 * OpenClaw roles: "user", "assistant", "toolResult"
 * OTEL roles: "user", "assistant", "tool"
 */
export function convertInputMessages(
  historyMessages: unknown[],
  currentPrompt?: unknown,
): OtelInputMessage[] {
  const result: OtelInputMessage[] = [];

  for (const raw of historyMessages) {
    if (typeof raw !== "object" || raw === null) continue;
    const msg = raw as Record<string, unknown>;
    const role = msg.role as string;

    if (role === "user") {
      result.push({
        role: "user",
        parts: convertContentToParts(msg.content),
      });
    } else if (role === "assistant") {
      result.push({
        role: "assistant",
        parts: convertContentToParts(msg.content),
      });
    } else if (role === "toolResult") {
      const otelMsg: OtelInputMessage = {
        role: "tool",
        parts: [],
      };
      if (msg.toolName) otelMsg.name = msg.toolName as string;

      // Convert tool result content to tool_call_response parts
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const item of content) {
          if (typeof item === "object" && item !== null) {
            const part = item as Record<string, unknown>;
            if (part.type === "text") {
              otelMsg.parts.push({
                type: "tool_call_response",
                response: part.text,
                id: msg.toolCallId as string | undefined,
              });
            }
          }
        }
      } else if (typeof content === "string") {
        otelMsg.parts.push({
          type: "tool_call_response",
          response: content,
          id: msg.toolCallId as string | undefined,
        });
      }

      result.push(otelMsg);
    }
  }

  // Add current user prompt
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

/**
 * Convert an OpenClaw lastAssistant response object to OTEL Gen AI
 * semantic convention output messages format.
 *
 * OpenClaw format:
 *   {role: "assistant", content: [{type: "text", text: "..."}, ...], stopReason: "stop", ...}
 *
 * OTEL format:
 *   [{role: "assistant", parts: [{type: "text", content: "..."}], finish_reason: "stop"}]
 */
export function convertOutputMessages(
  lastAssistant: unknown,
): OtelOutputMessage[] {
  if (typeof lastAssistant !== "object" || lastAssistant === null) {
    if (typeof lastAssistant === "string") {
      return [
        {
          role: "assistant",
          parts: [{ type: "text", content: lastAssistant }],
        },
      ];
    }
    return [];
  }

  const msg = lastAssistant as Record<string, unknown>;
  const otelMsg: OtelOutputMessage = {
    role: "assistant",
    parts: convertContentToParts(msg.content),
  };

  if (msg.stopReason) {
    otelMsg.finish_reason = msg.stopReason as string;
  }

  return [otelMsg];
}
