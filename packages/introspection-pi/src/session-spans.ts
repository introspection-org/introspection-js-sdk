/**
 * A Pi session file as the GenAI span list `/v1/conversations/{id}/export`
 * returns.
 *
 * A Pi run that is not instrumented (a Harbor trial launches the Pi CLI
 * directly) emits no model-call spans, so its conversation exists only as
 * Pi's session file. This renders that file in the platform's format with the
 * attribute builders the live instrumentation uses, so everything downstream
 * of the format (the ATIF projection in `introspection-sdk`) reads a local
 * run and a stored conversation alike.
 */

import type { Message, ToolCall } from "@earendil-works/pi-ai";
import {
  nestAttributes,
  type GenAiSpan,
  type GenAiSpanList,
} from "@introspection-sdk/types";

import {
  chatRequestAttributes,
  chatResponseAttributes,
  executeToolAttributes,
  executeToolResultAttribute,
  type McpToolOrigin,
} from "./attributes.js";
import { renderCompactionSummary } from "./convert.js";

export interface PiSessionToSpansOptions {
  /**
   * The MCP server serving a tool, by its Pi tool name, as
   * `instrumentSession` takes it; its `execute_tool` spans then carry the
   * same `mcp.*` attributes a live run records.
   */
  mcpTool?: (toolName: string) => McpToolOrigin | undefined;
}

/**
 * One `chat` span per model call and one `execute_tool` span per result.
 *
 * Throws when `content` has no session header: any other JSON lines, such as
 * a `pi --mode json` event stream, would otherwise render as an empty list.
 */
export function piSessionToSpans(
  content: string,
  conversationId: string,
  options: PiSessionToSpansOptions = {},
): GenAiSpanList {
  const meta = { conversationId, agentId: "root", agentName: "agent" };
  const spans: GenAiSpan[] = [];
  let clock = 0;
  const span = (
    name: string,
    message: Message,
    flat: Record<string, unknown>,
    status?: GenAiSpan["status"],
  ) => {
    // A span must not sort before the one it follows, whatever Pi stamped.
    clock = Math.max(clock + 1, message.timestamp);
    const time = new Date(clock).toISOString();
    spans.push({
      trace_id: conversationId,
      span_id: `span-${spans.length + 1}`,
      name,
      start_time: time,
      // The file holds one instant per message, so a span has no measurable
      // duration; it is still over, and a consumer must not read it as running.
      end_time: time,
      duration_ns: 0,
      ...(status ? { status } : {}),
      attributes: nestAttributes(flat),
    });
  };

  // Every message of the file, and the ones the model sees on its next call.
  // The two differ after a compaction.
  const messages: Message[] = [];
  let context: Message[] = [];
  // Entry id to the index of the first message at or after that entry.
  const messageIndex = new Map<string, number>();
  const compactionSummaries: string[] = [];
  const toolCalls = new Map<string, ToolCall>();
  let isSession = false;

  for (const line of content.split("\n")) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    isSession ||= entry.type === "session";
    if (typeof entry.id === "string") {
      messageIndex.set(entry.id, messages.length);
    }

    if (entry.type === "compaction" && typeof entry.summary === "string") {
      // What Pi rebuilds: the compaction's own system message, its summary,
      // then the messages it kept, in place of the history it replaced.
      const kept = messages.slice(
        messageIndex.get(entry.firstKeptEntryId as string) ?? messages.length,
      );
      compactionSummaries.push(entry.summary);
      context = [
        ...(entry.systemMessage ? [entry.systemMessage as Message] : []),
        {
          role: "user",
          content: [
            { type: "text", text: renderCompactionSummary(entry.summary) },
          ],
          timestamp: Date.parse(entry.timestamp as string) || 0,
        },
        ...kept.filter((message) => message.role !== "system"),
      ];
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;

    const message = entry.message as Message;
    if (message.role === "toolResult") {
      span(
        `execute_tool ${message.toolName}`,
        message,
        {
          ...executeToolAttributes(
            message.toolName,
            message.toolCallId,
            toolCalls.get(message.toolCallId)?.arguments,
            meta,
            undefined,
            options.mcpTool?.(message.toolName),
          ),
          // The shape the live instrumentation records from Pi's tool result.
          ...executeToolResultAttribute({
            content: message.content,
            ...(message.details !== undefined
              ? { details: message.details }
              : {}),
          }),
        },
        { code: message.isError ? "Error" : "Ok" },
      );
    } else if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "toolCall") toolCalls.set(part.id, part);
      }
      span(`chat ${message.model}`, message, {
        ...chatRequestAttributes(
          { provider: message.provider, id: message.model },
          { messages: context },
          meta,
          { compactionSummaries },
        ),
        ...chatResponseAttributes(message),
      });
    }
    messages.push(message);
    context = [...context, message];
  }

  if (!isSession) throw new Error("not a Pi session file: no session header");
  return {
    object: "list",
    data: spans,
    first_id: spans[0]?.span_id ?? null,
    last_id: spans.at(-1)?.span_id ?? null,
    has_more: false,
    next: null,
  };
}

const MCP_SERVER_BINDINGS: readonly string[] = ["live", "recipe", "local"];

/**
 * The `mcpTool` lookup for a JSON object of MCP origins keyed by Pi tool
 * name, as `pi-session-spans --mcp-tools` reads it.
 */
export function mcpToolLookupFromJson(
  json: string,
): (toolName: string) => McpToolOrigin | undefined {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("MCP tools must be a JSON object keyed by Pi tool name");
  }
  const origins = new Map<string, McpToolOrigin>();
  for (const [name, value] of Object.entries(parsed)) {
    const origin = value as Partial<McpToolOrigin> | null;
    if (
      typeof origin?.serverId !== "string" ||
      typeof origin.toolName !== "string" ||
      (origin.binding !== undefined &&
        !MCP_SERVER_BINDINGS.includes(origin.binding))
    ) {
      throw new Error(
        `MCP tool '${name}' needs a string serverId and toolName, and a binding of live, recipe or local`,
      );
    }
    origins.set(name, {
      serverId: origin.serverId,
      toolName: origin.toolName,
      ...(origin.binding ? { binding: origin.binding } : {}),
    });
  }
  return (toolName) => origins.get(toolName);
}
