/**
 * Converter for AI SDK event data → Gen AI semantic conventions.
 *
 * Converts typed event objects (messages, tool definitions, step results)
 * from the AI SDK's TelemetryIntegration callbacks into the standardized
 * gen_ai format used by the Introspection backend.
 *
 * Used by {@link IntrospectionAISDKIntegration}.
 */

import type {
  InputMessage,
  OutputMessage,
  SystemInstruction,
  ToolDefinition,
  MessagePart,
} from "../types/genai.js";

// ---------------------------------------------------------------------------
// Local types — minimal shapes matching AI SDK data structures.
// Defined locally to avoid requiring `ai` as a compile-time dependency.
// ---------------------------------------------------------------------------

/** A content part within an AI SDK message. */
interface ContentPart {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  input?: unknown;
  result?: unknown;
  output?: unknown;
}

// ---------------------------------------------------------------------------
// Public conversion functions
// ---------------------------------------------------------------------------

/**
 * Convert AI SDK messages (ModelMessage[]) to gen_ai InputMessage[].
 * System messages are excluded — they're handled separately via
 * {@link extractSystemInstructions}.
 *
 * @param messages - Array of AI SDK ModelMessage objects.
 * @returns Array of gen_ai InputMessage objects (without system messages).
 */
export function convertMessagesToInputMessages(
  messages: readonly unknown[],
): InputMessage[] {
  const result: InputMessage[] = [];
  for (const msg of messages) {
    const m = msg as { role?: string; content?: unknown };
    if (!m || !m.role || m.role === "system") continue;
    result.push(convertOneMessage(m));
  }
  return result;
}

/**
 * Extract gen_ai system instructions from AI SDK's system field and messages.
 *
 * The AI SDK provides system prompts in two places:
 * - The `system` parameter (string, SystemModelMessage, or array)
 * - Messages with role "system"
 *
 * @param system - The AI SDK `system` field.
 * @param messages - The messages array (may contain system-role messages).
 * @returns System instructions in gen_ai format, or undefined if none.
 */
export function extractSystemInstructions(
  system: unknown,
  messages: readonly unknown[],
): SystemInstruction[] | undefined {
  const instructions: SystemInstruction[] = [];

  // From the `system` field
  if (typeof system === "string" && system) {
    instructions.push({ type: "text", content: system });
  } else if (system && typeof system === "object") {
    if (Array.isArray(system)) {
      for (const s of system) {
        const text = extractTextFromSystemMessage(s);
        if (text) instructions.push({ type: "text", content: text });
      }
    } else {
      const text = extractTextFromSystemMessage(system);
      if (text) instructions.push({ type: "text", content: text });
    }
  }

  // From system-role messages
  for (const msg of messages) {
    const m = msg as { role?: string; content?: unknown };
    if (m?.role === "system") {
      const content = m.content;
      if (typeof content === "string") {
        instructions.push({ type: "text", content });
      } else if (Array.isArray(content)) {
        const text = (content as ContentPart[])
          .filter((p) => p.type === "text")
          .map((p) => p.text || "")
          .join("");
        if (text) instructions.push({ type: "text", content: text });
      }
    }
  }

  return instructions.length > 0 ? instructions : undefined;
}

/**
 * Build gen_ai output messages from AI SDK step result data.
 *
 * Combines text, reasoning, and tool call outputs into a single assistant
 * OutputMessage, mirroring the order used by vercel.ts (reasoning → text → tool calls).
 *
 * @param options - Step result fields.
 * @returns Array of gen_ai OutputMessage objects.
 */
export function buildOutputMessages(options: {
  text?: string;
  reasoningText?: string;
  reasoning?: readonly { text?: string }[];
  toolCalls?: readonly {
    toolCallId: string;
    toolName: string;
    input: unknown;
  }[];
  finishReason?: string;
}): OutputMessage[] {
  const parts: MessagePart[] = [];

  // Reasoning first (mirrors vercel.ts order)
  if (options.reasoningText) {
    parts.push({ type: "thinking", content: options.reasoningText });
  } else if (options.reasoning?.length) {
    for (const r of options.reasoning) {
      if (r.text) parts.push({ type: "thinking", content: r.text });
    }
  }

  // Text content
  if (options.text) {
    parts.push({ type: "text", content: options.text });
  }

  // Tool calls
  if (options.toolCalls?.length) {
    for (const tc of options.toolCalls) {
      parts.push({
        type: "tool_call",
        name: tc.toolName,
        id: tc.toolCallId,
        arguments:
          typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input),
      });
    }
  }

  if (parts.length === 0) return [];

  return [
    {
      role: "assistant",
      parts,
      finish_reason: options.finishReason,
    },
  ];
}

/**
 * Convert AI SDK ToolSet to gen_ai ToolDefinition[].
 *
 * The AI SDK represents tools as `Record<string, Tool>` where each Tool has
 * description and parameters (usually a Zod schema). We extract what we can
 * without importing Zod.
 *
 * @param tools - AI SDK ToolSet (Record<string, Tool>).
 * @returns Array of gen_ai ToolDefinition objects, or undefined if no tools.
 */
export function convertToolsToToolDefinitions(
  tools: unknown,
): ToolDefinition[] | undefined {
  if (!tools || typeof tools !== "object") return undefined;

  const defs: ToolDefinition[] = [];
  for (const [name, tool] of Object.entries(tools as Record<string, unknown>)) {
    if (!tool || typeof tool !== "object") continue;
    const t = tool as Record<string, unknown>;
    defs.push({
      name,
      description:
        typeof t.description === "string" ? t.description : undefined,
      parameters: extractToolParameters(t.parameters),
    });
  }

  return defs.length > 0 ? defs : undefined;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function convertOneMessage(msg: {
  role?: string;
  content?: unknown;
}): InputMessage {
  const role = (msg.role || "user") as InputMessage["role"];
  const content = msg.content;
  const parts: MessagePart[] = [];

  if (typeof content === "string") {
    parts.push({ type: "text", content });
  } else if (Array.isArray(content)) {
    for (const part of content as ContentPart[]) {
      const converted = convertContentPart(part);
      if (converted) parts.push(converted);
    }
  }

  return { role, parts };
}

function convertContentPart(part: ContentPart): MessagePart | null {
  switch (part.type) {
    case "text":
      return { type: "text", content: part.text || "" };

    case "tool-call": {
      const args = part.args ?? part.input;
      return {
        type: "tool_call",
        name: part.toolName || "",
        id: part.toolCallId || "",
        arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
      };
    }

    case "tool-result": {
      const rawResult = part.result ?? part.output;
      let response: string;
      if (typeof rawResult === "string") {
        response = rawResult;
      } else if (
        rawResult &&
        typeof rawResult === "object" &&
        "value" in (rawResult as Record<string, unknown>)
      ) {
        response = JSON.stringify((rawResult as Record<string, unknown>).value);
      } else {
        response = JSON.stringify(rawResult);
      }
      return {
        type: "tool_call_response",
        id: part.toolCallId || "",
        response,
      };
    }

    case "reasoning":
      return { type: "thinking", content: part.text || "" };

    default:
      // Unknown part type — serialize as text fallback
      return { type: "text", content: JSON.stringify(part) };
  }
}

function extractTextFromSystemMessage(msg: unknown): string | null {
  if (typeof msg === "string") return msg;
  if (msg && typeof msg === "object") {
    const m = msg as Record<string, unknown>;
    if (typeof m.content === "string") return m.content;
    if (typeof m.text === "string") return m.text;
  }
  return null;
}

function extractToolParameters(
  parameters: unknown,
): Record<string, unknown> | undefined {
  if (!parameters || typeof parameters !== "object") return undefined;
  const p = parameters as Record<string, unknown>;

  // jsonSchema() wrapper — has a jsonSchema property
  if (p.jsonSchema && typeof p.jsonSchema === "object") {
    return p.jsonSchema as Record<string, unknown>;
  }

  // Plain JSON Schema object (has 'type' and 'properties')
  if (p.type === "object" && p.properties) {
    return p as Record<string, unknown>;
  }

  return undefined;
}
