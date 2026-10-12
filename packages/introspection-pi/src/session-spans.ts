/**
 * A Pi session file, or a `pi --mode json` event stream, as the GenAI span
 * list `/v1/conversations/{id}/export` returns.
 *
 * A Pi run that is not instrumented (a Harbor trial launches the Pi CLI
 * directly) emits no model-call spans, so its conversation exists only as
 * Pi's own files. This renders those files in the platform's format with the
 * attribute builders the live instrumentation uses, so everything downstream
 * of the format (the ATIF projection in `introspection-sdk`) reads a local
 * run and a stored conversation alike.
 */

import type {
  AssistantMessage,
  Message,
  ToolCall,
} from "@earendil-works/pi-ai";
import type {
  GenAiSpan,
  GenAiSpanList,
  SpanAttributes,
} from "@introspection-sdk/types";

import {
  chatRequestAttributes,
  chatResponseAttributes,
  executeToolAttributes,
  executeToolResultAttribute,
} from "./attributes.js";
import { renderCompactionSummary } from "./convert.js";

export interface PiCompaction {
  summary: string;
  /** How many of the file's messages precede the compaction. */
  at: number;
  /**
   * Index of the first message the compaction kept in model context. Absent
   * when the file does not say, as in an event stream, which has no entry ids.
   */
  firstKept?: number;
  timestamp: number;
}

export interface PiFile {
  messages: Message[];
  compactions: PiCompaction[];
}

// Stored as JSON strings on a span, returned parsed by the conversation read.
const JSON_ATTRIBUTES = new Set([
  "gen_ai.input.messages",
  "gen_ai.output.messages",
  "gen_ai.system_instructions",
  "gen_ai.tool.definitions",
]);

/** Read the messages of a session file or of a JSON event stream. */
export function parsePiFile(content: string): PiFile {
  const messages: Message[] = [];
  const compactions: PiCompaction[] = [];
  // Entry id to the index of the first message at or after that entry.
  const messageIndex = new Map<string, number>();
  for (const line of content.split("\n")) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      // The event stream is mixed with diagnostic output.
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.id === "string") {
      messageIndex.set(record.id, messages.length);
    }
    if (
      (record.type === "message" || record.type === "message_end") &&
      typeof record.message === "object" &&
      record.message !== null
    ) {
      messages.push(record.message as Message);
    } else if (
      record.type === "compaction" &&
      typeof record.summary === "string"
    ) {
      const firstKept =
        typeof record.firstKeptEntryId === "string"
          ? messageIndex.get(record.firstKeptEntryId)
          : undefined;
      compactions.push({
        summary: record.summary,
        at: messages.length,
        ...(firstKept !== undefined ? { firstKept } : {}),
        timestamp:
          typeof record.timestamp === "string"
            ? Date.parse(record.timestamp) || 0
            : 0,
      });
    }
  }
  return { messages, compactions };
}

function nest(flat: Record<string, unknown>): Record<string, unknown> {
  const tree: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(flat)) {
    if (raw === undefined) continue;
    const value =
      JSON_ATTRIBUTES.has(key) && typeof raw === "string"
        ? JSON.parse(raw)
        : raw;
    const path = key.split(".");
    const leaf = path.pop() ?? key;
    let node = tree;
    for (const part of path) {
      node[part] ??= {};
      node = node[part] as Record<string, unknown>;
    }
    node[leaf] = value;
  }
  return tree;
}

/** One `chat` span per model call and one `execute_tool` span per result. */
export function piFileToSpans(
  file: PiFile,
  conversationId: string,
): GenAiSpanList {
  const meta = { conversationId, agentId: "root", agentName: "agent" };
  const options = {
    compactionSummaries: file.compactions.map(({ summary }) => summary),
  };
  const spans: GenAiSpan[] = [];
  let clock = 0;
  const span = (
    name: string,
    message: Message | undefined,
    flat: Record<string, unknown>,
    status?: GenAiSpan["status"],
  ) => {
    // A span must not sort before the one it follows, whatever Pi stamped.
    clock = Math.max(clock + 1, message?.timestamp ?? 0);
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
      attributes: nest(flat) as SpanAttributes,
    });
  };

  // What the model saw of the first `end` messages: after a compaction, its
  // summary and the messages it kept, not the history it replaced.
  const context = (end: number): Message[] => {
    const compaction = file.compactions
      .filter(({ at, firstKept }) => firstKept !== undefined && at <= end)
      .at(-1);
    if (compaction?.firstKept === undefined) return file.messages.slice(0, end);
    return [
      {
        role: "user",
        content: [
          { type: "text", text: renderCompactionSummary(compaction.summary) },
        ],
        timestamp: compaction.timestamp,
      },
      ...file.messages.slice(compaction.firstKept, end),
    ];
  };

  const toolCalls = new Map<string, ToolCall>();
  let answered = 0;
  file.messages.forEach((message, index) => {
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
      const assistant: AssistantMessage = message;
      for (const part of assistant.content) {
        if (part.type === "toolCall") toolCalls.set(part.id, part);
      }
      span(`chat ${assistant.model}`, assistant, {
        ...chatRequestAttributes(
          { provider: assistant.provider, id: assistant.model } as Parameters<
            typeof chatRequestAttributes
          >[0],
          { messages: context(index) },
          meta,
          options,
        ),
        ...chatResponseAttributes(assistant),
      });
      answered = index + 1;
    }
  });

  if (answered < file.messages.length) {
    // Messages no model call answered, such as the prompt of a failed run.
    span("chat", file.messages[file.messages.length - 1], {
      ...chatRequestAttributes(
        { provider: undefined, id: undefined } as unknown as Parameters<
          typeof chatRequestAttributes
        >[0],
        { messages: context(file.messages.length) },
        meta,
        options,
      ),
    });
  }
  return {
    object: "list",
    data: spans,
    first_id: spans[0]?.span_id ?? null,
    last_id: spans.at(-1)?.span_id ?? null,
    has_more: false,
    next: null,
  };
}
