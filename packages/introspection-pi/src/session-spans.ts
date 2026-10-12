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

import type { AssistantMessage, Message } from "@earendil-works/pi-ai";

import {
  chatRequestAttributes,
  chatResponseAttributes,
  executeToolAttributes,
} from "./attributes.js";

export interface SessionSpan {
  trace_id: string;
  span_id: string;
  name: string;
  start_time: string;
  status?: { code: "Ok" | "Error" };
  attributes: Record<string, unknown>;
}

export interface SessionSpanList {
  object: "list";
  data: SessionSpan[];
}

export interface PiFile {
  messages: Message[];
  compactionSummaries: string[];
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
  const compactionSummaries: string[] = [];
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
      compactionSummaries.push(record.summary);
    }
  }
  return { messages, compactionSummaries };
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
): SessionSpanList {
  const meta = { conversationId, agentId: "root", agentName: "agent" };
  const options = { compactionSummaries: file.compactionSummaries };
  const spans: SessionSpan[] = [];
  let clock = 0;
  const span = (
    name: string,
    message: Message | undefined,
    flat: Record<string, unknown>,
    status?: SessionSpan["status"],
  ) => {
    // A span must not sort before the one it follows, whatever Pi stamped.
    clock = Math.max(clock + 1, message?.timestamp ?? 0);
    spans.push({
      trace_id: conversationId,
      span_id: `span-${spans.length + 1}`,
      name,
      start_time: new Date(clock).toISOString(),
      ...(status ? { status } : {}),
      attributes: nest(flat),
    });
  };

  let answered = 0;
  file.messages.forEach((message, index) => {
    if (message.role === "toolResult") {
      span(
        `execute_tool ${message.toolName}`,
        message,
        executeToolAttributes(
          message.toolName,
          message.toolCallId,
          undefined,
          meta,
        ),
        { code: message.isError ? "Error" : "Ok" },
      );
    } else if (message.role === "assistant") {
      const assistant: AssistantMessage = message;
      span(`chat ${assistant.model}`, assistant, {
        ...chatRequestAttributes(
          { provider: assistant.provider, id: assistant.model } as Parameters<
            typeof chatRequestAttributes
          >[0],
          { messages: file.messages.slice(0, index) },
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
        { messages: file.messages },
        meta,
        options,
      ),
    });
  }
  return { object: "list", data: spans };
}
