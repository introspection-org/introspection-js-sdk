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
   * for an event stream: its messages carry no entry ids, so the entry a
   * compaction names cannot be found and later calls keep the full history.
   */
  firstKept?: number;
  /** The prompt and tool state Pi recorded at the compaction, if any. */
  systemMessage?: Message;
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
      continue;
    }
    // A session file holds the compaction entry; an event stream reports the
    // same result on `compaction_end`.
    const compaction =
      record.type === "compaction_end" ? record.result : record;
    if (typeof compaction !== "object" || compaction === null) continue;
    const { type, summary, firstKeptEntryId, systemMessage, timestamp } =
      compaction as Record<string, unknown>;
    if (record.type !== "compaction_end" && type !== "compaction") continue;
    if (typeof summary !== "string") continue;
    const firstKept =
      typeof firstKeptEntryId === "string"
        ? messageIndex.get(firstKeptEntryId)
        : undefined;
    compactions.push({
      summary,
      at: messages.length,
      ...(firstKept !== undefined ? { firstKept } : {}),
      ...(typeof systemMessage === "object" && systemMessage !== null
        ? { systemMessage: systemMessage as Message }
        : {}),
      timestamp: typeof timestamp === "string" ? Date.parse(timestamp) || 0 : 0,
    });
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

  // What the model saw of the first `end` messages. After a compaction that
  // is what Pi rebuilds: the compaction's own system message, its summary,
  // the messages it kept and those that followed, not the history it replaced.
  const context = (end: number): Message[] => {
    const compaction = file.compactions
      .filter(({ at, firstKept }) => firstKept !== undefined && at <= end)
      .at(-1);
    if (compaction?.firstKept === undefined) return file.messages.slice(0, end);
    return [
      ...(compaction.systemMessage ? [compaction.systemMessage] : []),
      {
        role: "user",
        content: [
          { type: "text", text: renderCompactionSummary(compaction.summary) },
        ],
        timestamp: compaction.timestamp,
      },
      ...file.messages
        .slice(compaction.firstKept, compaction.at)
        .filter((message) => message.role !== "system"),
      ...file.messages.slice(compaction.at, end),
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
