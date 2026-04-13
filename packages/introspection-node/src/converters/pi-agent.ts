/**
 * Converts Pi Agent SDK message types to/from OTel Gen AI semantic convention format.
 *
 * Pure functions — produce JSON strings matching the gen_ai.input.messages
 * and gen_ai.output.messages attribute schemas.
 *
 * Gen AI semconv message format:
 *   { role: "user"|"assistant"|"tool", parts: MessagePart[], finish_reason?: string }
 *
 * MessagePart types:
 *   { type: "text", content: string }
 *   { type: "thinking", content: string }
 *   { type: "tool_call", name: string, id?: string, arguments?: unknown }
 *   { type: "tool_call_response", id?: string, result?: unknown }
 */

// Pi Agent SDK types — structural typing to avoid import dependency.

interface UserMessage {
  role: "user";
  content: string | ContentBlock[];
}

interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  id?: string;
  arguments?: unknown;
  toolName?: string;
  toolCallId?: string;
  content?: unknown;
  isError?: boolean;
}

interface AssistantMessage {
  role: "assistant";
  content: ContentBlock[];
  stopReason?: string;
  provider?: string;
  model?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
  };
}

interface ToolResultMessage {
  role: "toolResult";
  toolName?: string;
  toolCallId?: string;
  content?: unknown;
}

type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage;

// OTel Gen AI semconv output types

interface SemconvPart {
  type: "text" | "thinking" | "tool_call" | "tool_call_response";
  content?: string;
  name?: string;
  id?: string;
  arguments?: unknown;
  result?: unknown;
}

interface SemconvMessage {
  role: "user" | "assistant" | "tool";
  parts: SemconvPart[];
  finish_reason?: string;
}

/**
 * Convert Pi Agent Message[] to gen_ai.input.messages JSON string.
 */
export function piMessagesToSemconv(messages: unknown[]): string {
  const result: SemconvMessage[] = [];

  for (const msg of messages) {
    const m = msg as AgentMessage;
    if (m.role === "user") {
      const userMsg = m as UserMessage;
      const text =
        typeof userMsg.content === "string"
          ? userMsg.content
          : extractTextFromBlocks(userMsg.content);
      result.push({
        role: "user",
        parts: [{ type: "text", content: text }],
      });
    } else if (m.role === "assistant") {
      result.push(convertAssistantMessage(m as AssistantMessage));
    } else if (m.role === "toolResult") {
      const tr = m as ToolResultMessage;
      result.push({
        role: "tool",
        parts: [
          {
            type: "tool_call_response",
            id: tr.toolCallId,
            result: extractToolResultContent(tr.content),
          },
        ],
      });
    }
  }

  return JSON.stringify(result);
}

/**
 * Convert a single Pi AssistantMessage to gen_ai.output.messages JSON string.
 */
export function piAssistantToSemconv(result: unknown): string {
  const msg = result as AssistantMessage;
  const converted = convertAssistantMessage(msg);
  return JSON.stringify([converted]);
}

/**
 * Wrap a system prompt string in gen_ai.system_instructions format.
 */
export function piSystemPromptToSemconv(systemPrompt: string): string {
  return JSON.stringify([{ type: "text", content: systemPrompt }]);
}

/**
 * Convert gen_ai.input.messages semconv format back to Pi Agent Message[] format.
 *
 * Used to hydrate conversation history when resuming an agent task from the
 * DP API's reconstructed `messages` payload.
 *
 * - Thinking parts are skipped (no thinkingSignature stored).
 * - tool_call_response toolName is resolved from preceding assistant tool_call parts.
 * - Returns typed-as-unknown[] to avoid importing pi-ai types.
 */
export function semconvToPiMessages(raw: unknown): unknown[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];

  const messages: unknown[] = [];
  // Build toolCallId -> toolName map from assistant tool_call parts
  const toolNameById = new Map<string, string>();

  for (const msg of raw as SemconvMessage[]) {
    const parts = msg.parts ?? [];

    if (msg.role === "user") {
      const text = parts
        .filter((p) => p.type === "text")
        .map((p) => p.content ?? "")
        .join("");
      if (!text) continue;
      messages.push({ role: "user", content: text, timestamp: 0 });
    } else if (msg.role === "assistant") {
      const content: unknown[] = [];
      for (const part of parts) {
        if (part.type === "text" && part.content) {
          content.push({ type: "text", text: part.content });
        } else if (part.type === "tool_call") {
          if (part.id && part.name) {
            toolNameById.set(part.id, part.name);
          }
          let args = part.arguments ?? {};
          if (typeof args === "string") {
            try {
              args = JSON.parse(args);
            } catch {
              args = {};
            }
          }
          content.push({
            type: "toolCall",
            id: part.id ?? "",
            name: part.name ?? "",
            arguments: args,
          });
        }
        // Skip thinking parts: thinkingSignature not stored in semconv
      }
      if (content.length === 0) continue;
      messages.push({
        role: "assistant",
        content,
        api: "anthropic-messages",
        provider: "anthropic",
        model: "",
        usage: { input: 0, output: 0, totalTokens: 0 },
        stopReason: msg.finish_reason ?? "end_turn",
        timestamp: 0,
      });
    } else if (msg.role === "tool") {
      for (const part of parts) {
        if (part.type !== "tool_call_response") continue;
        const id = part.id ?? "";
        // name is not stored in semconv tool_call_response; resolve from map
        const name =
          (part as SemconvPart & { name?: string }).name ??
          toolNameById.get(id) ??
          "";
        if (!id || !name) {
          continue;
        }
        const resultRaw = part.result;
        const result =
          typeof resultRaw === "string"
            ? resultRaw
            : resultRaw != null
              ? JSON.stringify(resultRaw)
              : "";
        messages.push({
          role: "toolResult",
          toolCallId: id,
          toolName: name,
          content: [{ type: "text", text: result }],
          isError: false,
          timestamp: 0,
        });
      }
    }
  }

  return sanitizeToolPairing(messages);
}

/**
 * Remove toolResult messages whose toolCallId doesn't have a matching
 * toolCall in the preceding assistant message. Also strips unmatched
 * tool_use blocks from the final assistant message.
 */
function sanitizeToolPairing(messages: unknown[]): unknown[] {
  const result: unknown[] = [];
  let activeToolCallIds = new Set<string>();

  for (const msg of messages) {
    const m = msg as {
      role?: string;
      toolCallId?: string;
      content?: unknown[];
    };

    if (m.role === "assistant") {
      activeToolCallIds = new Set<string>();
      if (Array.isArray(m.content)) {
        for (const block of m.content) {
          const b = block as { type?: string; id?: string };
          if (b.type === "toolCall" && b.id) {
            activeToolCallIds.add(b.id);
          }
        }
      }
      result.push(msg);
    } else if (m.role === "toolResult") {
      if (m.toolCallId && activeToolCallIds.has(m.toolCallId)) {
        activeToolCallIds.delete(m.toolCallId);
        result.push(msg);
      }
    } else {
      activeToolCallIds = new Set();
      result.push(msg);
    }
  }

  // Strip unmatched tool_use blocks from the last assistant message
  if (activeToolCallIds.size > 0 && result.length > 0) {
    for (let i = result.length - 1; i >= 0; i--) {
      const m = result[i] as { role?: string; content?: unknown[] };
      if (m.role !== "assistant") continue;

      if (Array.isArray(m.content)) {
        const cleaned = m.content.filter((block) => {
          const b = block as { type?: string; id?: string };
          return !(
            b.type === "toolCall" &&
            b.id &&
            activeToolCallIds.has(b.id)
          );
        });

        if (cleaned.length === 0) {
          result.splice(i, 1);
        } else {
          (m as { content: unknown[] }).content = cleaned;
        }
      }
      break;
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function convertAssistantMessage(msg: AssistantMessage): SemconvMessage {
  const parts: SemconvPart[] = [];

  for (const block of msg.content ?? []) {
    switch (block.type) {
      case "text":
        if (block.text) {
          parts.push({ type: "text", content: block.text });
        }
        break;
      case "thinking":
        if (block.thinking || block.text) {
          parts.push({
            type: "thinking",
            content: block.thinking || block.text,
          });
        }
        break;
      case "toolCall":
        parts.push({
          type: "tool_call",
          name: block.name,
          id: block.id,
          arguments: block.arguments,
        });
        break;
      case "tool_result":
        parts.push({
          type: "tool_call_response",
          id: block.toolCallId,
          result: extractToolResultContent(block.content),
        });
        break;
      default:
        if (block.text) {
          parts.push({ type: "text", content: block.text });
        }
        break;
    }
  }

  const result: SemconvMessage = {
    role: "assistant",
    parts,
  };

  if (msg.stopReason) {
    result.finish_reason = msg.stopReason;
  }

  return result;
}

function extractTextFromBlocks(blocks: ContentBlock[]): string {
  return blocks
    .map((b) => {
      if (b.type === "text") return b.text ?? "";
      return "";
    })
    .filter(Boolean)
    .join("");
}

function extractToolResultContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!content) return "";

  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        if (typeof block === "string") return block;
        const b = block as { type?: string; text?: string };
        if (b?.type === "text" && b.text) return b.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }

  if (typeof content === "object") {
    const c = content as { text?: string; content?: string };
    return c.text ?? c.content ?? JSON.stringify(content);
  }

  return String(content);
}
