/**
 * The shared transcript projection — two transports, one fold.
 *
 * A chat product sees the same conversation twice: live as AG-UI protocol
 * events while a run executes, and after a refresh as persisted GenAI spans
 * from `/v1/conversations/{id}/items`. Rendering them through two private
 * projections is where parity bugs live — duplicated answers on replay,
 * tool calls that vanish after a refresh, reconciliation heuristics that
 * compare shapes that were never comparable.
 *
 * This module folds both transports into the same `TranscriptEntry[]`:
 *
 * - {@link foldSpans} — spans (the refresh / hydration path). Pairs with the
 *   items read; with `agent_scope: "root"` the input is already the main
 *   transcript plus delegation wrappers, and this fold turns it into render
 *   order.
 * - {@link foldAgui} / {@link TranscriptAccumulator} — AG-UI events (the
 *   live path), incrementally.
 * - {@link mergeTranscripts} — stored entries win, unmatched live entries
 *   survive; correlation runs on the cross-transport keys (`callId`,
 *   `gen_ai.response.id`, `client_message_id`) rather than on transport-local
 *   ids.
 *
 * The span fold's rules are the ones every consumer previously reimplemented:
 * chronological ordering, the two-source tool-call dedupe (a call appears
 * both as an `execute_tool` span and as an assistant `tool_call` output
 * part), tool results joined from `tool`-role input messages, and stable ids
 * derived from span identity so re-folding can never duplicate an entry.
 */

import { EventType, type AGUIEvent } from "@ag-ui/core";
import type {
  GenAiSpan,
  InputMessage,
  MessagePart,
  OutputMessage,
  TranscriptDelegationEntry,
  TranscriptEntry,
  TranscriptMessageEntry,
  TranscriptStatus,
  TranscriptToolEntry,
} from "@introspection-sdk/types";
import {
  genAiInputMessages,
  genAiOutputMessages,
} from "@introspection-sdk/types";

/** `gen_ai.operation.name` values that mark a delegation boundary. */
const DELEGATION_OPERATIONS = new Set(["invoke_agent", "create_agent"]);

function spanStatus(span: GenAiSpan): TranscriptStatus {
  return span.status?.code === "Error" ? "error" : "complete";
}

function textOf(parts: MessagePart[]): string {
  return parts
    .filter((part) => part.type === "text")
    .map((part) => String((part as { content?: unknown }).content ?? ""))
    .join("\n");
}

function thinkingOf(parts: MessagePart[]): string {
  return parts
    .filter((part) => part.type === "thinking" || part.type === "reasoning")
    .map((part) => String((part as { content?: unknown }).content ?? ""))
    .join("\n");
}

/**
 * Fold persisted conversation items into transcript entries, oldest first.
 *
 * Accepts the spans in any page order; entries come out in chronological
 * span order with each span's own message ordering preserved. A tool call
 * seen from more than one source keeps its first position and merges the
 * later source's fields onto it.
 */
export function foldSpans(spans: GenAiSpan[]): TranscriptEntry[] {
  const ordered = [...spans].sort(
    (a, b) =>
      Date.parse(a.start_time) - Date.parse(b.start_time) ||
      (a.span_id ?? "").localeCompare(b.span_id ?? ""),
  );

  const entries: TranscriptEntry[] = [];
  const toolsByCallId = new Map<string, TranscriptToolEntry>();

  const upsertTool = (
    callId: string,
    patch: Partial<Omit<TranscriptToolEntry, "kind" | "id" | "callId">>,
  ): void => {
    const existing = toolsByCallId.get(callId);
    if (existing) {
      if (patch.name) existing.name = patch.name;
      if (patch.arguments !== undefined) existing.arguments = patch.arguments;
      if (patch.result !== undefined) {
        existing.result = patch.result;
        existing.status = patch.status ?? "complete";
      } else if (patch.status === "error") {
        existing.status = "error";
      }
      if (patch.spanId) existing.spanId = patch.spanId;
      return;
    }
    const entry: TranscriptToolEntry = {
      kind: "tool",
      id: `tool:${callId}`,
      callId,
      name: patch.name ?? "",
      status: patch.status ?? "running",
      ...(patch.arguments !== undefined ? { arguments: patch.arguments } : {}),
      ...(patch.result !== undefined ? { result: patch.result } : {}),
      ...(patch.spanId ? { spanId: patch.spanId } : {}),
    };
    toolsByCallId.set(callId, entry);
    entries.push(entry);
  };

  for (const span of ordered) {
    const genAi = span.attributes.gen_ai;
    const spanId = span.span_id;

    if (DELEGATION_OPERATIONS.has(genAi?.operation?.name ?? "")) {
      const delegation: TranscriptDelegationEntry = {
        kind: "delegation",
        id: `span:${spanId ?? span.trace_id}:delegation`,
        status:
          span.status?.code === "Error"
            ? "error"
            : span.end_time || span.duration_ns !== undefined
              ? "complete"
              : "running",
        ...(genAi?.agent?.id ? { agentId: genAi.agent.id } : {}),
        ...(genAi?.agent?.name ? { agentName: genAi.agent.name } : {}),
        ...(span.duration_ns !== undefined
          ? { durationNs: span.duration_ns }
          : {}),
        ...(spanId ? { spanId } : {}),
      };
      entries.push(delegation);
      continue;
    }

    // Source one of a tool call: the `execute_tool` span's own attributes.
    const call = genAi?.tool?.call;
    if (call?.id) {
      upsertTool(call.id, {
        name: genAi?.tool?.name,
        arguments: call.arguments,
        status: spanStatus(span),
        spanId,
      });
    }

    const inputMessages: InputMessage[] = genAiInputMessages(span);
    const clientMessageId =
      span.attributes.introspection?.conversation?.client_message_id;
    const userMessages = inputMessages.filter((m) => m.role === "user");
    inputMessages.forEach((message, index) => {
      if (message.role === "user") {
        const text = textOf(message.parts ?? []);
        if (!text) return;
        // client_message_id names the turn's optimistic user message; it can
        // only be the id when the delta carries exactly one candidate.
        const stableId =
          clientMessageId && userMessages.length === 1
            ? clientMessageId
            : `span:${spanId ?? span.trace_id}:user:${index}`;
        const entry: TranscriptMessageEntry = {
          kind: "message",
          id: stableId,
          role: "user",
          text,
          ...(clientMessageId ? { clientMessageId } : {}),
          ...(spanId ? { spanId } : {}),
        };
        entries.push(entry);
        return;
      }
      if (message.role === "tool") {
        for (const part of message.parts ?? []) {
          if (part.type !== "tool_call_response" || !part.id) continue;
          upsertTool(part.id, {
            name: part.name,
            result: part.response,
            status: "complete",
            spanId,
          });
        }
      }
    });

    const outputMessages: OutputMessage[] = genAiOutputMessages(span);
    outputMessages.forEach((message, index) => {
      if (message.role !== "assistant") return;
      const parts = message.parts ?? [];
      // Source two of a tool call: the assistant output's `tool_call` parts.
      for (const part of parts) {
        if (part.type !== "tool_call" || !part.id) continue;
        upsertTool(part.id, {
          name: part.name,
          arguments:
            typeof part.arguments === "string"
              ? part.arguments
              : part.arguments !== undefined
                ? JSON.stringify(part.arguments)
                : undefined,
          status: spanStatus(span),
          spanId,
        });
      }
      const text = textOf(parts);
      const thinking = thinkingOf(parts);
      if (!text && !thinking) return;
      const responseId = genAi?.response?.id;
      const entry: TranscriptMessageEntry = {
        kind: "message",
        id: responseId ?? `span:${spanId ?? span.trace_id}:assistant:${index}`,
        role: "assistant",
        text,
        ...(thinking ? { thinking } : {}),
        ...(responseId ? { responseId } : {}),
        ...(spanId ? { spanId } : {}),
      };
      entries.push(entry);
    });
  }

  return entries;
}

/**
 * Incremental AG-UI → transcript fold for the live path.
 *
 * Push events as they stream; read {@link entries} at any point for the
 * transcript so far. Entries are owned and mutated by the accumulator —
 * snapshot (`structuredClone` or a shallow map) before storing them
 * elsewhere.
 *
 * Only content-bearing events change the transcript. Lifecycle events are
 * consumed for status transitions (`RUN_ERROR` marks running tools as
 * errored); `STEP_*`, `CUSTOM`, snapshots, and unknown event types are
 * ignored, so the fold degrades instead of throwing as the protocol grows.
 */
export class TranscriptAccumulator {
  readonly entries: TranscriptEntry[] = [];
  private readonly messagesById = new Map<string, TranscriptMessageEntry>();
  private readonly toolsByCallId = new Map<string, TranscriptToolEntry>();
  private lastAssistant: TranscriptMessageEntry | undefined;
  private pendingThinking = "";

  push(event: AGUIEvent): void {
    switch (event.type) {
      case EventType.TEXT_MESSAGE_START: {
        const { messageId, role } = event as {
          messageId: string;
          role?: string;
        };
        this.openMessage(messageId, role === "user" ? "user" : "assistant");
        return;
      }
      case EventType.TEXT_MESSAGE_CONTENT: {
        const { messageId, delta } = event as {
          messageId: string;
          delta: string;
        };
        this.appendText(messageId, delta);
        return;
      }
      case EventType.TEXT_MESSAGE_CHUNK: {
        const { messageId, delta, role } = event as {
          messageId?: string;
          delta?: string;
          role?: string;
        };
        if (!messageId) return;
        this.openMessage(messageId, role === "user" ? "user" : "assistant");
        if (delta) this.appendText(messageId, delta);
        return;
      }
      case EventType.THINKING_TEXT_MESSAGE_CONTENT: {
        const { delta } = event as { delta: string };
        if (this.lastAssistant) {
          this.lastAssistant.thinking =
            (this.lastAssistant.thinking ?? "") + delta;
        } else {
          this.pendingThinking += delta;
        }
        return;
      }
      case EventType.TOOL_CALL_START: {
        const { toolCallId, toolCallName } = event as {
          toolCallId: string;
          toolCallName: string;
        };
        this.openTool(toolCallId, toolCallName);
        return;
      }
      case EventType.TOOL_CALL_ARGS: {
        const { toolCallId, delta } = event as {
          toolCallId: string;
          delta: string;
        };
        this.appendArgs(toolCallId, delta);
        return;
      }
      case EventType.TOOL_CALL_CHUNK: {
        const { toolCallId, toolCallName, delta } = event as {
          toolCallId?: string;
          toolCallName?: string;
          delta?: string;
        };
        if (!toolCallId) return;
        this.openTool(toolCallId, toolCallName ?? "");
        if (delta) this.appendArgs(toolCallId, delta);
        return;
      }
      case EventType.TOOL_CALL_RESULT: {
        const { toolCallId, content } = event as {
          toolCallId: string;
          content: string;
        };
        const tool = this.openTool(toolCallId, "");
        tool.result = content;
        tool.status = "complete";
        return;
      }
      case EventType.RUN_ERROR: {
        for (const tool of this.toolsByCallId.values()) {
          if (tool.status === "running") tool.status = "error";
        }
        return;
      }
      default:
        return;
    }
  }

  private openMessage(
    messageId: string,
    role: "user" | "assistant",
  ): TranscriptMessageEntry {
    const existing = this.messagesById.get(messageId);
    if (existing) return existing;
    const entry: TranscriptMessageEntry = {
      kind: "message",
      id: messageId,
      role,
      text: "",
    };
    if (role === "assistant") {
      this.lastAssistant = entry;
      if (this.pendingThinking) {
        entry.thinking = this.pendingThinking;
        this.pendingThinking = "";
      }
    }
    this.messagesById.set(messageId, entry);
    this.entries.push(entry);
    return entry;
  }

  private appendText(messageId: string, delta: string): void {
    const entry =
      this.messagesById.get(messageId) ??
      this.openMessage(messageId, "assistant");
    entry.text += delta;
  }

  private openTool(callId: string, name: string): TranscriptToolEntry {
    const existing = this.toolsByCallId.get(callId);
    if (existing) {
      if (name && !existing.name) existing.name = name;
      return existing;
    }
    const entry: TranscriptToolEntry = {
      kind: "tool",
      id: `tool:${callId}`,
      callId,
      name,
      status: "running",
    };
    this.toolsByCallId.set(callId, entry);
    this.entries.push(entry);
    return entry;
  }

  private appendArgs(callId: string, delta: string): void {
    const tool = this.openTool(callId, "");
    tool.arguments = (tool.arguments ?? "") + delta;
  }
}

/** One-shot convenience over {@link TranscriptAccumulator}. */
export function foldAgui(events: Iterable<AGUIEvent>): TranscriptEntry[] {
  const acc = new TranscriptAccumulator();
  for (const event of events) acc.push(event);
  return acc.entries;
}

/**
 * Converge a live transcript onto its stored twin after a refresh.
 *
 * Stored entries are truth and keep their order. A live entry survives only
 * when nothing stored correlates with it — matched by `callId` for tools,
 * and for messages by id, `gen_ai.response.id`, or `client_message_id`
 * (the live message id is transport-local, so the correlation keys are what
 * make a hydrated entry and its live twin collide instead of duplicating).
 */
export function mergeTranscripts(
  stored: TranscriptEntry[],
  live: TranscriptEntry[],
): TranscriptEntry[] {
  const messageKeys = new Set<string>();
  const toolCallIds = new Set<string>();
  const delegationKeys = new Set<string>();
  for (const entry of stored) {
    if (entry.kind === "message") {
      messageKeys.add(entry.id);
      if (entry.responseId) messageKeys.add(entry.responseId);
      if (entry.clientMessageId) messageKeys.add(entry.clientMessageId);
    } else if (entry.kind === "tool") {
      toolCallIds.add(entry.callId);
    } else {
      delegationKeys.add(entry.agentId ?? entry.id);
    }
  }
  const unmatched = live.filter((entry) => {
    if (entry.kind === "message") return !messageKeys.has(entry.id);
    if (entry.kind === "tool") return !toolCallIds.has(entry.callId);
    return !delegationKeys.has(entry.agentId ?? entry.id);
  });
  return [...stored, ...unmatched];
}
