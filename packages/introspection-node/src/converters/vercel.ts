/**
 * Converter for Vercel AI SDK telemetry spans → Gen AI semantic conventions.
 *
 * The Vercel AI SDK emits spans with `ai.*` attributes when
 * `experimental_telemetry: { isEnabled: true }` is set on streamText/generateText.
 * This converter translates those to `gen_ai.*` so the Introspection frontend
 * can render them in the conversation view.
 */

import type { Attributes } from "@opentelemetry/api";

interface VercelMessage {
  role: string;
  content?: string | VercelContentPart[];
}

interface VercelContentPart {
  type: string;
  text?: string;
  content?: string;
  toolName?: string;
  name?: string;
  toolCallId?: string;
  id?: string;
  args?: string | Record<string, unknown>;
}

interface VercelTool {
  type?: string;
  name?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  parameters?: Record<string, unknown>;
}

interface GenAIPart {
  type: string;
  content?: string;
  name?: string;
  id?: string;
  arguments?: string;
}

interface GenAIMessage {
  role: string;
  parts: GenAIPart[];
}

/** Check if a span is a Vercel AI SDK span worth converting.
 * Only converts child "do*" spans (doStream, doGenerate) which have
 * the actual prompt/response data with proper message windows.
 * Parent wrapper spans (ai.streamText, ai.generateText) are skipped
 * to avoid duplicate conversation steps without user messages. */
export function isVercelAISpan(attrs: Attributes): boolean {
  const operationId = attrs["ai.operationId"];
  return typeof operationId === "string" && operationId.includes(".do");
}

/**
 * Convert Vercel AI SDK `ai.*` attributes to `gen_ai.*` semconv attributes.
 * Returns only the gen_ai attributes to merge — does NOT remove originals.
 */
export function convertVercelAIToGenAI(
  attrs: Attributes,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // gen_ai.operation.name
  result["gen_ai.operation.name"] = "chat";

  // gen_ai.usage.cache_read.input_tokens from ai.usage.cachedInputTokens
  const cachedInput = attrs["ai.usage.cachedInputTokens"];
  if (typeof cachedInput === "number") {
    result["gen_ai.usage.cache_read.input_tokens"] = cachedInput;
  }

  // gen_ai.conversation.id from telemetry metadata (set by app)
  const metadataConvId = attrs["ai.telemetry.metadata.gen_ai.conversation.id"];
  if (typeof metadataConvId === "string") {
    result["gen_ai.conversation.id"] = metadataConvId;
  }

  // gen_ai.request.model and gen_ai.system from ai.model.*
  const modelId = attrs["ai.model.id"];
  if (typeof modelId === "string" && !attrs["gen_ai.request.model"]) {
    result["gen_ai.request.model"] = modelId;
  }
  const modelProvider = attrs["ai.model.provider"];
  if (typeof modelProvider === "string" && !attrs["gen_ai.system"]) {
    result["gen_ai.system"] = modelProvider;
  }

  // Vercel AI SDK stores prompt data in two formats:
  // - Child spans (doStream): flat keys like ai.prompt.messages, ai.prompt.toolChoice
  // - Parent spans (streamText): single JSON string in ai.prompt
  const promptMessages = attrs["ai.prompt.messages"];
  const promptRaw = attrs["ai.prompt"];
  let parsedMessages: VercelMessage[] | null = null;
  let parsedSystem: string | null = null;

  if (typeof promptMessages === "string") {
    try {
      const parsed: unknown = JSON.parse(promptMessages);
      if (Array.isArray(parsed)) parsedMessages = parsed as VercelMessage[];
    } catch {
      /* ignore */
    }
  } else if (typeof promptRaw === "string") {
    try {
      const parsed = JSON.parse(promptRaw) as Record<string, unknown>;
      if (Array.isArray(parsed?.messages))
        parsedMessages = parsed.messages as VercelMessage[];
      if (typeof parsed?.system === "string") parsedSystem = parsed.system;
    } catch {
      /* ignore */
    }
  }

  // gen_ai.input.messages — excluding system messages
  const nonSystemMessages = parsedMessages
    ? parsedMessages.filter((m) => m.role !== "system")
    : null;
  if (nonSystemMessages && nonSystemMessages.length > 0) {
    const converted = nonSystemMessages.map(convertVercelMessageToGenAI);
    result["gen_ai.input.messages"] = JSON.stringify(converted);
  }

  // gen_ai.output.messages — build from ai.response.text + ai.response.reasoning
  const responseText = attrs["ai.response.text"];
  const responseReasoning = attrs["ai.response.reasoning"];
  if (typeof responseText === "string" && responseText) {
    const parts: GenAIPart[] = [];
    if (typeof responseReasoning === "string" && responseReasoning) {
      parts.push({ type: "thinking", content: responseReasoning });
    }
    parts.push({ type: "text", content: responseText });
    result["gen_ai.output.messages"] = JSON.stringify([
      { role: "assistant", parts },
    ]);
  }

  // gen_ai.tool.definitions — parse ai.prompt.tools JSON strings
  const promptTools = attrs["ai.prompt.tools"];
  if (typeof promptTools === "string") {
    try {
      const parsed: unknown = JSON.parse(promptTools);
      if (Array.isArray(parsed)) {
        result["gen_ai.tool.definitions"] = JSON.stringify(
          (parsed as (string | VercelTool)[])
            .map((t) => {
              if (typeof t === "string") {
                try {
                  return JSON.parse(t) as VercelTool;
                } catch {
                  return { name: t } as VercelTool;
                }
              }
              return t;
            })
            .map((t) => ({
              type: t.type || "function",
              name: t.name || "",
              description: t.description || "",
              parameters: t.inputSchema || t.parameters || undefined,
            })),
        );
      }
    } catch {
      // ignore
    }
  } else if (Array.isArray(promptTools)) {
    const tools = (promptTools as string[]).map((t) => {
      const parsed = (typeof t === "string" ? JSON.parse(t) : t) as VercelTool;
      return {
        type: parsed.type || "function",
        name: parsed.name || "",
        description: parsed.description || "",
        parameters: parsed.inputSchema || parsed.parameters || undefined,
      };
    });
    result["gen_ai.tool.definitions"] = JSON.stringify(tools);
  }

  // gen_ai.agent.name — from telemetry functionId or operation
  const functionId = attrs["ai.telemetry.functionId"];
  if (typeof functionId === "string" && functionId) {
    result["gen_ai.agent.name"] = functionId;
  }

  // gen_ai.system_instructions — from parsed system prompt or system role messages
  if (parsedSystem) {
    result["gen_ai.system_instructions"] = JSON.stringify([
      { type: "text", content: parsedSystem },
    ]);
  } else if (parsedMessages) {
    const systemMsgs = parsedMessages.filter((m) => m.role === "system");
    if (systemMsgs.length > 0) {
      result["gen_ai.system_instructions"] = JSON.stringify(
        systemMsgs.map((m) => ({
          type: "text",
          content:
            typeof m.content === "string"
              ? m.content
              : JSON.stringify(m.content),
        })),
      );
    }
  }

  return result;
}

function convertVercelMessageToGenAI(msg: VercelMessage): GenAIMessage {
  const role = msg.role || "user";

  if (role === "system") {
    return {
      role,
      parts: [{ type: "text", content: extractTextContent(msg.content) }],
    };
  }

  return {
    role,
    parts: extractParts(msg.content),
  };
}

function extractTextContent(content: VercelMessage["content"]): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p.type === "text")
      .map((p) => p.text || p.content || "")
      .join("");
  }
  return String(content || "");
}

function extractParts(content: VercelMessage["content"]): GenAIPart[] {
  if (typeof content === "string") {
    return [{ type: "text", content }];
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (part.type === "text") {
        return { type: "text", content: part.text || part.content || "" };
      }
      if (part.type === "tool-call" || part.type === "tool_call") {
        return {
          type: "tool_call",
          name: part.toolName || part.name || "",
          id: part.toolCallId || part.id || "",
          arguments:
            typeof part.args === "string"
              ? part.args
              : JSON.stringify(part.args),
        };
      }
      return { type: "text", content: JSON.stringify(part) };
    });
  }
  return [{ type: "text", content: String(content || "") }];
}
