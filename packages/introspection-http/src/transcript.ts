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
 *   items read; with `agent: "root"` the input is already the main
 *   transcript plus delegation wrappers, and this fold turns it into render
 *   order.
 * - {@link foldAgui} / {@link TranscriptAccumulator} — AG-UI events (the
 *   live path), incrementally.
 * - {@link mergeTranscripts} — stored entries win, unmatched live entries
 *   survive; correlation runs on the cross-transport keys (`callId`,
 *   message-id aliases, delegation `invocationId`) rather than on
 *   transport-local ids.
 *
 * The span fold's rules are the ones every consumer previously reimplemented:
 * chronological span ordering with a fixed within-span order (user inputs,
 * then one assistant entry, then tool calls in their original part order),
 * the two-source tool-call dedupe (a call appears both as an `execute_tool`
 * span and as an assistant `tool_call` output part), tool results joined from
 * `tool`-role input messages, and stable ids derived from span identity so
 * re-folding can never duplicate an entry.
 *
 * Tool status means execution status, never argument status: an assistant
 * `tool_call` part only proves the model finished *requesting* the call, so
 * it folds as `running`; `complete` / `error` come from an ended
 * `execute_tool` span, a `tool_call_response` part, or a live
 * `TOOL_CALL_RESULT` (whose `isError` bit the runtime preserves).
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
  TranscriptToolEntry,
} from "@introspection-sdk/types";
import {
  genAiInputMessages,
  genAiOutputMessages,
} from "@introspection-sdk/types";

/** `gen_ai.operation.name` values that mark a delegation boundary. */
const DELEGATION_OPERATIONS = new Set(["invoke_agent", "create_agent"]);

/** The recipes management tool whose `start` action launches a subagent. */
const AGENT_TOOL_NAME = "agent";

/** AG-UI `CUSTOM` frame mapping a live message id to its provider alias. */
const MESSAGE_IDENTITY_EVENT = "introspection.message_identity";

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The error bit a tool response carries, in the shapes emitters use. */
function responseIsError(value: unknown): boolean {
  const record = recordOf(value);
  if (!record) return false;
  return (
    record.isError === true ||
    Boolean(record.error) ||
    record.status === "error"
  );
}

function spanEnded(span: GenAiSpan): boolean {
  return Boolean(span.end_time) || span.duration_ns !== undefined;
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
 * span order. Within one chat span the order is canonical and deliberately
 * simple: new user inputs, then one assistant entry carrying all of that
 * output message's text and thinking, then its tool calls in their original
 * `MessagePart[]` order. A tool call seen from more than one source keeps
 * its first position and merges the later source's fields onto it.
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
      } else if (patch.status && patch.status !== "running") {
        // Execution outcomes overwrite; a later `running` sighting never
        // downgrades a call that already completed or failed.
        existing.status = patch.status;
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
        id: `span:${spanId ?? span.trace_id}:delegation`,
        status:
          span.status?.code === "Error"
            ? "error"
            : spanEnded(span)
              ? "complete"
              : "running",
        ...(invocationId ? { invocationId } : {}),
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

    // An `execute_tool` span is the execution itself: its end state is the
    // call's status, and an un-ended span means the tool is still running.
    const call = genAi?.tool?.call;
    if (call?.id) {
      upsertTool(call.id, {
        name: genAi?.tool?.name,
        arguments: call.arguments,
        status: spanEnded(span)
          ? span.status?.code === "Error"
            ? "error"
            : "complete"
          : "running",
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
            status: responseIsError(part.response) ? "error" : "complete",
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
      // The assistant's `tool_call` parts follow the message, in part order.
      // The chat span only proves the model finished *requesting* the call,
      // so this source always folds as `running` — completion comes from the
      // execute_tool span or the tool_call_response part.
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
          status: "running",
          spanId,
        });
      }
    });
  }

  return entries;
}

/** Non-content state the live fold surfaces beside the transcript. */
export interface TranscriptAccumulatorOptions {
  /** Called with each `ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA` payload. */
  onActivity?: (event: AGUIEvent) => void;
  /** Called with each `CUSTOM` control frame the fold consumes or skips. */
  onControl?: (event: AGUIEvent) => void;
}

/**
 * Incremental AG-UI → transcript fold for the live path.
 *
 * Push events as they stream; read {@link entries} at any point for the
 * transcript so far. Entries are owned and mutated by the accumulator —
 * snapshot (`structuredClone` or a shallow map) before storing them
 * elsewhere.
 *
 * Covers the protocol the runtime actually emits: text messages, the
 * `REASONING_*` family (buffered and attached to the associated assistant
 * message), the full `TOOL_CALL_*` lifecycle with the result's error bit,
 * `MESSAGES_SNAPSHOT` as a baseline upsert, delegation via the `agent`
 * management tool, and the `introspection.message_identity` control frame
 * that aliases a live message id to its persisted provider response id.
 * Activity and control frames are surfaced through
 * {@link TranscriptAccumulatorOptions} instead of being folded into chat
 * content; unknown event types are ignored, so the fold degrades instead of
 * throwing as the protocol grows.
 */
export class TranscriptAccumulator {
  readonly entries: TranscriptEntry[] = [];
  private readonly messagesById = new Map<string, TranscriptMessageEntry>();
  private readonly toolsByCallId = new Map<string, TranscriptToolEntry>();
  private readonly delegationsByCallId = new Map<
    string,
    TranscriptDelegationEntry
  >();
  private readonly options: TranscriptAccumulatorOptions;
  private lastAssistant: TranscriptMessageEntry | undefined;
  private pendingThinking = "";

  constructor(options: TranscriptAccumulatorOptions = {}) {
    this.options = options;
  }

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
      // The runtime streams reasoning *before* the text message it belongs
      // to, so deltas buffer until the next assistant message opens rather
      // than attaching to whichever message happened to stream last.
      case EventType.REASONING_MESSAGE_CONTENT:
      case EventType.REASONING_MESSAGE_CHUNK: {
        const { delta } = event as { delta?: string };
        if (delta) this.pendingThinking += delta;
        return;
      }
      case EventType.REASONING_START:
      case EventType.REASONING_MESSAGE_START:
      case EventType.REASONING_MESSAGE_END:
      case EventType.REASONING_END:
        return;
      // Compatibility input: legacy emitters stream thinking against the
      // already-open assistant message rather than ahead of it.
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
      case EventType.MESSAGES_SNAPSHOT: {
        this.applyMessagesSnapshot(event);
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
      // END seals the arguments only — execution is still in flight, so the
      // status stays `running`. It is also the earliest point the sealed
      // args can reveal an `agent` start call, i.e. a delegation.
      case EventType.TOOL_CALL_END: {
        const { toolCallId } = event as { toolCallId: string };
        this.maybeConvertToDelegation(toolCallId);
        return;
      }
      case EventType.TOOL_CALL_RESULT: {
        const { toolCallId, content } = event as {
          toolCallId: string;
          content: string;
        };
        const isError = (event as { isError?: boolean }).isError === true;
        this.maybeConvertToDelegation(toolCallId);
        const delegation = this.delegationsByCallId.get(toolCallId);
        if (delegation) {
          this.applyDelegationLaunchResult(delegation, content, isError);
          return;
        }
        const tool = this.openTool(toolCallId, "");
        tool.result = content;
        tool.status = isError ? "error" : "complete";
        return;
      }
      // The runtime closes unresolved tools itself before terminal frames;
      // this is the fold's own backstop for emitters that do not. A running
      // delegation is deliberately left open — its completion is the child
      // run's, not this run's.
      case EventType.RUN_FINISHED: {
        for (const tool of this.toolsByCallId.values()) {
          if (tool.status === "running") tool.status = "error";
        }
        return;
      }
      case EventType.RUN_ERROR: {
        for (const tool of this.toolsByCallId.values()) {
          if (tool.status === "running") tool.status = "error";
        }
        return;
      }
      case EventType.ACTIVITY_SNAPSHOT:
      case EventType.ACTIVITY_DELTA: {
        this.options.onActivity?.(event);
        return;
      }
      case EventType.CUSTOM: {
        const { name, value } = event as { name?: string; value?: unknown };
        if (name === MESSAGE_IDENTITY_EVENT) {
          const identity = recordOf(value);
          const messageId = identity?.messageId;
          const responseId = identity?.responseId;
          if (typeof messageId === "string" && typeof responseId === "string") {
            const message = this.messagesById.get(messageId);
            if (message) message.responseId = responseId;
          }
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

  /** A baseline upsert: known ids update in place, new ones append. */
  private applyMessagesSnapshot(event: AGUIEvent): void {
    const { messages } = event as {
      messages?: Array<{
        id?: string;
        role?: string;
        content?: unknown;
        toolCalls?: Array<{
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      }>;
    };
    for (const message of messages ?? []) {
      if (!message.id) continue;
      if (message.role === "user" || message.role === "assistant") {
        const entry = this.openMessage(message.id, message.role);
        if (typeof message.content === "string") entry.text = message.content;
      }
      for (const call of message.toolCalls ?? []) {
        if (!call.id) continue;
        const tool = this.openTool(call.id, call.function?.name ?? "");
        if (call.function?.arguments !== undefined) {
          tool.arguments = call.function.arguments;
        }
      }
    }
  }

  /**
   * An `agent` tool call whose sealed args are a `start` action is a
   * delegation, not a management tool the transcript should render: the
   * entry converts in place (same position), keyed by the launching call.
   */
  private maybeConvertToDelegation(callId: string): void {
    const tool = this.toolsByCallId.get(callId);
    if (!tool || tool.name !== AGENT_TOOL_NAME) return;
    let args: Record<string, unknown> | null = null;
    try {
      args = recordOf(JSON.parse(tool.arguments ?? ""));
    } catch {
      return;
    }
    if (!args) return;
    const action = args.action;
    if (action !== undefined && action !== "start") return;
    const delegation: TranscriptDelegationEntry = {
      kind: "delegation",
      id: `delegation-tool:${callId}`,
      sourceToolCallId: callId,
      status: "running",
      ...(typeof args.name === "string" ? { agentName: args.name } : {}),
      ...(typeof args.label === "string" ? { label: args.label } : {}),
    };
    const index = this.entries.indexOf(tool);
    if (index !== -1) this.entries[index] = delegation;
    this.toolsByCallId.delete(callId);
    this.delegationsByCallId.set(callId, delegation);
  }

  /**
   * The `agent` tool's result means "the child was launched", never "the
   * child finished": it contributes the durable invocation id and only a
   * launch *failure* moves the status — completion comes from child
   * activity or the persisted wrapper span.
   */
  private applyDelegationLaunchResult(
    delegation: TranscriptDelegationEntry,
    content: string,
    isError: boolean,
  ): void {
    if (isError) {
      delegation.status = "error";
      return;
    }
    let result: Record<string, unknown> | null = null;
    try {
      result = recordOf(JSON.parse(content));
    } catch {
      return;
    }
    const agent = recordOf(recordOf(result?.details)?.agent);
    const invocationId = agent?.agent_run_id;
    if (typeof invocationId === "string" && invocationId) {
      delegation.invocationId = invocationId;
    }
    const childStatus = agent?.status;
    if (childStatus === "completed") delegation.status = "complete";
    else if (childStatus === "failed" || childStatus === "error") {
      delegation.status = "error";
    }
  }
}

/** One-shot convenience over {@link TranscriptAccumulator}. */
export function foldAgui(events: Iterable<AGUIEvent>): TranscriptEntry[] {
  const acc = new TranscriptAccumulator();
  for (const event of events) acc.push(event);
  return acc.entries;
}

function messageKeys(entry: TranscriptMessageEntry): string[] {
  const keys = [entry.id];
  if (entry.responseId) keys.push(entry.responseId);
  if (entry.clientMessageId) keys.push(entry.clientMessageId);
  return keys;
}

/**
 * Converge a live transcript onto its stored twin after a refresh.
 *
 * Stored entries are truth and keep their order. A live entry survives only
 * when nothing stored correlates with it:
 *
 * - **messages** — every alias on both sides participates (`id`,
 *   `gen_ai.response.id`, `client_message_id`); the live id is
 *   transport-local, and the `introspection.message_identity` frame is what
 *   gives a live entry the `responseId` its hydrated twin folds under.
 * - **tools** — `callId`.
 * - **delegations** — by invocation, not agent role: `invocationId` first,
 *   then the launching `sourceToolCallId`, then entry id; `agentId` only
 *   correlates when neither side carries an invocation id, so two
 *   invocations of the same `researcher` stay two entries.
 */
export function mergeTranscripts(
  stored: TranscriptEntry[],
  live: TranscriptEntry[],
): TranscriptEntry[] {
  const storedMessageKeys = new Set<string>();
  const toolCallIds = new Set<string>();
  const delegationKeys = new Set<string>();
  const legacyDelegationAgentIds = new Set<string>();
  for (const entry of stored) {
    if (entry.kind === "message") {
      for (const key of messageKeys(entry)) storedMessageKeys.add(key);
    } else if (entry.kind === "tool") {
      toolCallIds.add(entry.callId);
    } else if (entry.kind === "delegation") {
      delegationKeys.add(entry.id);
      if (entry.invocationId) delegationKeys.add(entry.invocationId);
      else if (entry.agentId) legacyDelegationAgentIds.add(entry.agentId);
      if (entry.sourceToolCallId) delegationKeys.add(entry.sourceToolCallId);
    }
  }
  const unmatched = live.filter((entry) => {
    if (entry.kind === "message") {
      return !messageKeys(entry).some((key) => storedMessageKeys.has(key));
    }
    if (entry.kind === "tool") return !toolCallIds.has(entry.callId);
    if (entry.kind === "delegation") {
      if (entry.invocationId && delegationKeys.has(entry.invocationId)) {
        return false;
      }
      if (
        entry.sourceToolCallId &&
        delegationKeys.has(entry.sourceToolCallId)
      ) {
        return false;
      }
      if (delegationKeys.has(entry.id)) return false;
      return !(
        !entry.invocationId &&
        entry.agentId &&
        legacyDelegationAgentIds.has(entry.agentId)
      );
    }
    return true;
  });
  return [...stored, ...unmatched];
}
