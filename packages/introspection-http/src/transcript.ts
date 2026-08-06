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

function toolSpanStatus(span: GenAiSpan): TranscriptStatus {
  if (span.status?.code === "Error") return "error";
  return span.end_time || span.duration_ns !== undefined
    ? "complete"
    : "running";
}

function toolResultIsError(result: unknown): boolean {
  if (!result || typeof result !== "object") return false;
  const value = result as Record<string, unknown>;
  return (
    value.isError === true ||
    value.status === "error" ||
    value.error !== undefined
  );
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
      } else if (patch.status === "complete" && existing.status === "running") {
        existing.status = "complete";
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
      const invocationId = span.attributes.introspection?.agent?.invocation_id;
      const delegation: TranscriptDelegationEntry = {
        kind: "delegation",
        id: invocationId
          ? `delegation:${invocationId}`
          : `span:${spanId ?? span.trace_id}:delegation`,
        status:
          span.status?.code === "Error"
            ? "error"
            : span.end_time || span.duration_ns !== undefined
              ? "complete"
              : "running",
        ...(genAi?.agent?.id ? { agentId: genAi.agent.id } : {}),
        ...(genAi?.agent?.name ? { agentName: genAi.agent.name } : {}),
        ...(invocationId ? { invocationId } : {}),
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
        status: toolSpanStatus(span),
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
            status: toolResultIsError(part.response) ? "error" : "complete",
            spanId,
          });
        }
      }
    });

    const outputMessages: OutputMessage[] = genAiOutputMessages(span);
    outputMessages.forEach((message, index) => {
      if (message.role !== "assistant") return;
      const parts = message.parts ?? [];
      const text = textOf(parts);
      const thinking = thinkingOf(parts);
      if (text || thinking) {
        const responseId = genAi?.response?.id;
        const entry: TranscriptMessageEntry = {
          kind: "message",
          id:
            responseId ?? `span:${spanId ?? span.trace_id}:assistant:${index}`,
          role: "assistant",
          text,
          ...(thinking ? { thinking } : {}),
          ...(responseId ? { responseId } : {}),
          ...(spanId ? { spanId } : {}),
        };
        entries.push(entry);
      }
      // One deterministic within-span rule: render the assistant's content,
      // then its requested tools in their original part order.
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
          // A model finishing the request does not mean the tool finished.
          // Only its execute span or response can settle the invocation.
          status: "running",
          spanId,
        });
      }
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
 * UI-only activity and control events are surfaced through callbacks instead
 * of being forced into the render-oriented transcript shape.
 */
export interface TranscriptAccumulatorOptions {
  /** Receives activity snapshots for app-specific progress UI. */
  onActivity?: (event: AGUIEvent) => void;
  /** Receives run lifecycle and custom control frames. */
  onControl?: (event: AGUIEvent) => void;
}

export class TranscriptAccumulator {
  readonly entries: TranscriptEntry[] = [];
  private readonly messagesById = new Map<string, TranscriptMessageEntry>();
  private readonly toolsByCallId = new Map<string, TranscriptToolEntry>();
  private readonly delegationsByCallId = new Map<
    string,
    TranscriptDelegationEntry
  >();
  private readonly responseIdsByMessageId = new Map<string, string>();
  private currentAssistantMessageId: string | undefined;
  private pendingThinking = "";

  constructor(private readonly options: TranscriptAccumulatorOptions = {}) {}

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
      case EventType.TEXT_MESSAGE_END: {
        const { messageId } = event as { messageId: string };
        if (this.currentAssistantMessageId === messageId) {
          this.currentAssistantMessageId = undefined;
        }
        return;
      }
      case EventType.REASONING_MESSAGE_CONTENT:
      case EventType.REASONING_MESSAGE_CHUNK:
      case EventType.THINKING_TEXT_MESSAGE_CONTENT: {
        const { delta } = event as { delta?: string };
        if (delta) this.appendThinking(delta);
        return;
      }
      case EventType.REASONING_START:
      case EventType.REASONING_MESSAGE_START:
      case EventType.REASONING_MESSAGE_END:
      case EventType.REASONING_END:
        return;
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
        const { toolCallId, content, isError, error } = event as {
          toolCallId: string;
          content: string;
          isError?: boolean;
          error?: unknown;
        };
        this.applyToolResult(
          toolCallId,
          content,
          Boolean(isError || error !== undefined),
        );
        return;
      }
      case EventType.TOOL_CALL_END:
        // END seals the arguments stream. The invocation is still running
        // until TOOL_CALL_RESULT (or RUN_ERROR) supplies its outcome.
        return;
      case EventType.MESSAGES_SNAPSHOT:
        this.applyMessagesSnapshot(event);
        return;
      case EventType.ACTIVITY_SNAPSHOT:
        this.options.onActivity?.(event);
        return;
      case EventType.CUSTOM:
        this.applyCustomEvent(event);
        this.options.onControl?.(event);
        return;
      case EventType.RUN_STARTED:
      case EventType.RUN_FINISHED:
        this.options.onControl?.(event);
        return;
      case EventType.RUN_ERROR: {
        for (const tool of this.toolsByCallId.values()) {
          if (tool.status === "running") tool.status = "error";
        }
        this.options.onControl?.(event);
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
      this.currentAssistantMessageId = messageId;
      if (this.pendingThinking) {
        entry.thinking = this.pendingThinking;
        this.pendingThinking = "";
      }
    }
    const responseId = this.responseIdsByMessageId.get(messageId);
    if (responseId) entry.responseId = responseId;
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

  private appendThinking(delta: string): void {
    const assistant = this.currentAssistantMessageId
      ? this.messagesById.get(this.currentAssistantMessageId)
      : undefined;
    if (assistant) {
      assistant.thinking = (assistant.thinking ?? "") + delta;
    } else {
      this.pendingThinking += delta;
    }
  }

  private applyMessagesSnapshot(event: AGUIEvent): void {
    const { messages } = event as {
      messages: Array<{
        id: string;
        role: string;
        content?: unknown;
        error?: unknown;
        toolCallId?: string;
        toolCalls?: Array<{
          id: string;
          function?: { name?: string; arguments?: string };
        }>;
      }>;
    };

    this.entries.length = 0;
    this.messagesById.clear();
    this.toolsByCallId.clear();
    this.delegationsByCallId.clear();
    this.currentAssistantMessageId = undefined;
    this.pendingThinking = "";

    let hasActivity = false;
    for (const message of messages) {
      if (message.role === "reasoning") {
        this.pendingThinking += this.contentText(message.content);
        continue;
      }
      if (message.role === "activity") {
        hasActivity = true;
        continue;
      }
      if (message.role === "user" || message.role === "assistant") {
        const entry = this.openMessage(message.id, message.role);
        entry.text = this.contentText(message.content);
        if (message.role === "assistant") {
          for (const call of message.toolCalls ?? []) {
            const tool = this.openTool(call.id, call.function?.name ?? "");
            if (call.function?.arguments !== undefined) {
              tool.arguments = call.function.arguments;
            }
          }
          this.currentAssistantMessageId = undefined;
        }
        continue;
      }
      if (message.role === "tool" && message.toolCallId) {
        this.applyToolResult(
          message.toolCallId,
          message.content,
          message.error !== undefined,
        );
      }
    }
    if (hasActivity) this.options.onActivity?.(event);
  }

  private applyCustomEvent(event: AGUIEvent): void {
    const { name, value } = event as { name: string; value?: unknown };
    if (name !== "introspection.message_identity" || !value) return;
    const identity = value as { messageId?: unknown; responseId?: unknown };
    if (
      typeof identity.messageId !== "string" ||
      typeof identity.responseId !== "string"
    ) {
      return;
    }
    this.responseIdsByMessageId.set(identity.messageId, identity.responseId);
    const message = this.messagesById.get(identity.messageId);
    if (message) message.responseId = identity.responseId;
  }

  private applyToolResult(
    callId: string,
    result: unknown,
    isError: boolean,
  ): void {
    const tool = this.openTool(callId, "");
    const args = this.jsonRecord(tool.arguments);
    const isAgentStart =
      tool.name === "agent" &&
      (args?.action === undefined || args.action === "start");
    if (!isAgentStart) {
      tool.result = result;
      tool.status = isError ? "error" : "complete";
      return;
    }

    let delegation = this.delegationsByCallId.get(callId);
    if (!delegation) {
      delegation = {
        kind: "delegation",
        id: `delegation-tool:${callId}`,
        sourceToolCallId: callId,
        ...(typeof args?.name === "string" ? { agentName: args.name } : {}),
        ...(typeof args?.label === "string" ? { label: args.label } : {}),
        status: isError ? "error" : "running",
      };
      const index = this.entries.indexOf(tool);
      if (index === -1) this.entries.push(delegation);
      else this.entries.splice(index, 1, delegation);
      this.toolsByCallId.delete(callId);
      this.delegationsByCallId.set(callId, delegation);
    }

    const body =
      typeof result === "string"
        ? this.jsonRecord(result)
        : this.record(result);
    const details = this.record(body?.details);
    const agent = this.record(details?.agent);
    if (typeof agent?.agent_run_id === "string") {
      delegation.invocationId = agent.agent_run_id;
    }
    if (typeof agent?.agent_name === "string") {
      delegation.agentName = agent.agent_name;
    }
    if (typeof agent?.label === "string") delegation.label = agent.label;
    delegation.status = isError
      ? "error"
      : this.delegationStatus(agent?.status);
  }

  private delegationStatus(status: unknown): TranscriptStatus {
    if (status === "failed" || status === "error") return "error";
    if (
      status === "completed" ||
      status === "interrupted" ||
      status === "closed"
    ) {
      return "complete";
    }
    return "running";
  }

  private jsonRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== "string") return this.record(value);
    try {
      return this.record(JSON.parse(value));
    } catch {
      return undefined;
    }
  }

  private record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private contentText(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const value = part as { text?: unknown; content?: unknown };
        if (typeof value.text === "string") return value.text;
        return typeof value.content === "string" ? value.content : "";
      })
      .join("");
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
      for (const key of [
        entry.invocationId,
        entry.sourceToolCallId,
        entry.spanId,
        entry.id,
      ]) {
        if (key) delegationKeys.add(key);
      }
    }
  }
  const unmatched = live.filter((entry) => {
    if (entry.kind === "message") {
      return ![entry.id, entry.responseId, entry.clientMessageId].some(
        (key) => key !== undefined && messageKeys.has(key),
      );
    }
    if (entry.kind === "tool") return !toolCallIds.has(entry.callId);
    return ![
      entry.invocationId,
      entry.sourceToolCallId,
      entry.spanId,
      entry.id,
    ].some((key) => key !== undefined && delegationKeys.has(key));
  });
  return [...stored, ...unmatched];
}
