/**
 * The shared transcript projection: `foldSpans` (stored spans), `foldAgui`
 * (live AG-UI events), and `mergeTranscripts` (refresh convergence).
 *
 * The parity test at the bottom is the point of the module: the same turn
 * folded from both transports converges to one set of entries instead of
 * duplicating — the failure class that per-app reconciliation heuristics
 * used to chase.
 */
import { describe, expect, it } from "vitest";
import {
  EventType,
  TranscriptAccumulator,
  foldAgui,
  foldSpans,
  mergeTranscripts,
} from "@introspection-sdk/http";
import type { AGUIEvent } from "@introspection-sdk/types";
import type { GenAiSpan, TranscriptEntry } from "@introspection-sdk/types";

function chatSpan(overrides: Partial<GenAiSpan> = {}): GenAiSpan {
  return {
    trace_id: "trace-1",
    span_id: "span-chat-1",
    start_time: "2026-01-01T00:00:01Z",
    end_time: "2026-01-01T00:00:03Z",
    duration_ns: 2_000_000_000,
    status: { code: "Ok" },
    attributes: {
      gen_ai: {
        operation: { name: "chat" },
        conversation: { id: "conv-1" },
        agent: { id: "agent", name: "agent" },
        response: { id: "resp-1" },
        input: {
          messages: [
            {
              role: "user",
              parts: [{ type: "text", content: "find react devs" }],
            },
          ],
        },
        output: {
          messages: [
            {
              role: "assistant",
              parts: [
                { type: "thinking", content: "considering" },
                {
                  type: "tool_call",
                  id: "call-1",
                  name: "shell",
                  arguments: '{"label":"Exploring: searching recruiters"}',
                },
                { type: "text", content: "Here are the results." },
              ],
              finish_reason: "stop",
            },
          ],
        },
      },
      introspection: {
        conversation: { position: 0, client_message_id: "cmid-1" },
      },
    },
    ...overrides,
  };
}

const EXECUTE_TOOL_SPAN: GenAiSpan = {
  trace_id: "trace-1",
  span_id: "span-tool-1",
  start_time: "2026-01-01T00:00:02Z",
  status: { code: "Ok" },
  attributes: {
    gen_ai: {
      operation: { name: "execute_tool" },
      tool: {
        name: "shell",
        call: {
          id: "call-1",
          arguments: '{"label":"Exploring: searching recruiters"}',
        },
      },
    },
  },
};

const TOOL_RESULT_SPAN: GenAiSpan = {
  trace_id: "trace-1",
  span_id: "span-chat-2",
  start_time: "2026-01-01T00:00:04Z",
  status: { code: "Ok" },
  attributes: {
    gen_ai: {
      operation: { name: "chat" },
      response: { id: "resp-2" },
      input: {
        messages: [
          {
            role: "tool",
            parts: [
              {
                type: "tool_call_response",
                id: "call-1",
                response: { ok: true },
              },
            ],
          },
        ],
      },
      output: {
        messages: [
          { role: "assistant", parts: [{ type: "text", content: "Done." }] },
        ],
      },
    },
  },
};

const DELEGATION_SPAN: GenAiSpan = {
  trace_id: "trace-1",
  span_id: "span-invoke-1",
  start_time: "2026-01-01T00:00:02.500Z",
  end_time: "2026-01-01T00:00:12Z",
  duration_ns: 9_500_000_000,
  status: { code: "Ok" },
  attributes: {
    gen_ai: {
      operation: { name: "invoke_agent" },
      agent: { id: "researcher:abc", name: "researcher" },
    },
    introspection: {
      agent: { parent_id: "", invocation_id: "child-run-1" },
    },
  },
};

describe("foldSpans", () => {
  it("folds a turn into user, tool, delegation and assistant entries", () => {
    // Pages arrive newest-first; the fold owns chronological order.
    const entries = foldSpans([
      TOOL_RESULT_SPAN,
      DELEGATION_SPAN,
      EXECUTE_TOOL_SPAN,
      chatSpan(),
    ]);

    // Within a span the order is canonical (§7i): user inputs, one
    // assistant entry, then its tool calls in original part order.
    expect(entries.map((e) => e.kind)).toEqual([
      "message", // user
      "message", // assistant resp-1
      "tool", // call-1, first position kept
      "delegation",
      "message", // assistant resp-2
    ]);

    const [user, assistant, tool, delegation, followUp] = entries;
    expect(user).toMatchObject({
      role: "user",
      id: "cmid-1",
      clientMessageId: "cmid-1",
      text: "find react devs",
    });
    // One entry despite three sources (execute_tool span, tool_call output
    // part, tool_call_response input part), with the result merged on.
    expect(tool).toMatchObject({
      callId: "call-1",
      name: "shell",
      status: "complete",
      result: { ok: true },
    });
    expect((tool as { arguments?: string }).arguments).toContain("Exploring");
    expect(assistant).toMatchObject({
      role: "assistant",
      id: "resp-1",
      responseId: "resp-1",
      text: "Here are the results.",
      thinking: "considering",
    });
    expect(delegation).toMatchObject({
      kind: "delegation",
      invocationId: "child-run-1",
      agentId: "researcher:abc",
      agentName: "researcher",
      status: "complete",
      durationNs: 9_500_000_000,
    });
    expect(followUp).toMatchObject({ id: "resp-2", text: "Done." });
  });

  it("keeps a requested-but-unexecuted tool call running", () => {
    // The chat span's tool_call part only proves the model finished
    // *requesting* the call — never that execution completed (§7h).
    const entries = foldSpans([chatSpan()]);
    const tool = entries.find((e) => e.kind === "tool");
    expect(tool).toMatchObject({ callId: "call-1", status: "running" });
  });

  it("derives tool status from execution, not the containing span", () => {
    // An un-ended execute_tool span is a still-running call; an errored
    // response part is an error even when its carrying span is Ok.
    const open = foldSpans([EXECUTE_TOOL_SPAN]);
    expect(open[0]).toMatchObject({ callId: "call-1", status: "running" });

    const errored = foldSpans([
      {
        ...TOOL_RESULT_SPAN,
        attributes: {
          gen_ai: {
            operation: { name: "chat" },
            input: {
              messages: [
                {
                  role: "tool",
                  parts: [
                    {
                      type: "tool_call_response",
                      id: "call-1",
                      response: { isError: true, error: "denied" },
                    },
                  ],
                },
              ],
            },
          },
        },
      },
    ]);
    expect(errored[0]).toMatchObject({ callId: "call-1", status: "error" });
  });

  it("marks errored spans and keeps synthetic ids stable across refolds", () => {
    const errored = chatSpan({
      span_id: "span-err",
      status: { code: "Error", message: "boom" },
      attributes: {
        gen_ai: {
          operation: { name: "chat" },
          output: {
            messages: [
              {
                role: "assistant",
                parts: [{ type: "text", content: "partial" }],
              },
            ],
          },
        },
      },
    });
    const first = foldSpans([errored]);
    const second = foldSpans([errored]);
    expect(first).toEqual(second);
    expect(first[0]?.id).toBe("span:span-err:assistant:0");
  });
});

describe("foldAgui", () => {
  const events: AGUIEvent[] = [
    { type: EventType.RUN_STARTED, threadId: "t", runId: "r" },
    { type: EventType.THINKING_TEXT_MESSAGE_CONTENT, delta: "consider" },
    {
      type: EventType.TEXT_MESSAGE_START,
      messageId: "resp-1",
      role: "assistant",
    },
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "resp-1",
      delta: "Here are ",
    },
    {
      type: EventType.TOOL_CALL_START,
      toolCallId: "call-1",
      toolCallName: "shell",
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "call-1",
      delta: '{"label":',
    },
    {
      type: EventType.TOOL_CALL_ARGS,
      toolCallId: "call-1",
      delta: '"Exploring"}',
    },
    {
      type: EventType.TOOL_CALL_RESULT,
      messageId: "m-tool",
      toolCallId: "call-1",
      content: "ok",
    },
    {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "resp-1",
      delta: "the results.",
    },
    { type: EventType.TEXT_MESSAGE_END, messageId: "resp-1" },
    { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" },
  ] as AGUIEvent[];

  it("assembles streamed deltas into the same entry shapes", () => {
    const entries = foldAgui(events);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: "message",
      id: "resp-1",
      role: "assistant",
      text: "Here are the results.",
      thinking: "consider",
    });
    expect(entries[1]).toMatchObject({
      kind: "tool",
      callId: "call-1",
      name: "shell",
      arguments: '{"label":"Exploring"}',
      status: "complete",
      result: "ok",
    });
  });

  it("marks still-running tools as errored on RUN_ERROR", () => {
    const acc = new TranscriptAccumulator();
    acc.push({
      type: EventType.TOOL_CALL_START,
      toolCallId: "call-9",
      toolCallName: "shell",
    } as AGUIEvent);
    acc.push({
      type: EventType.RUN_ERROR,
      message: "sandbox died",
    } as AGUIEvent);
    expect(acc.entries[0]).toMatchObject({ callId: "call-9", status: "error" });
  });

  it("upserts from chunk events and ignores unknown event types", () => {
    const entries = foldAgui([
      { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m1", delta: "hi" },
      {
        type: EventType.TOOL_CALL_CHUNK,
        toolCallId: "c1",
        toolCallName: "shell",
        delta: "{}",
      },
      { type: EventType.STEP_STARTED, stepName: "s" },
      {
        type: EventType.CUSTOM,
        name: "run_lifecycle",
        value: { phase: "thinking" },
      },
    ] as AGUIEvent[]);
    expect(entries.map((e) => e.kind)).toEqual(["message", "tool"]);
  });

  it("buffers REASONING deltas and attaches them to the next assistant message", () => {
    // The runtime streams reasoning before the text message it belongs to;
    // with a previous assistant message already open, the buffer must reach
    // the *next* message, not whichever streamed last (§7e).
    const entries = foldAgui([
      { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m0", delta: "prior" },
      { type: EventType.REASONING_START, messageId: "r1" },
      { type: EventType.REASONING_MESSAGE_START, messageId: "r1" },
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "r1",
        delta: "weigh ",
      },
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "r1",
        delta: "options",
      },
      { type: EventType.REASONING_MESSAGE_END, messageId: "r1" },
      { type: EventType.REASONING_END, messageId: "r1" },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "Go." },
    ] as AGUIEvent[]);
    expect(entries[0]).toMatchObject({ id: "m0", text: "prior" });
    expect((entries[0] as { thinking?: string }).thinking).toBeUndefined();
    expect(entries[1]).toMatchObject({
      id: "m1",
      text: "Go.",
      thinking: "weigh options",
    });
  });

  it("flushes buffered reasoning onto the open assistant message at RUN_ERROR", () => {
    // A turn that reasons, starts answering, then fails mid-stream. The
    // buffered reasoning has no *next* message to attach to, and used to be
    // discarded -- the transcript of a failed run lost the model's thinking
    // entirely, which is the run you most want it for.
    const entries = foldAgui([
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "Let" },
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "r1",
        delta: "second thoughts",
      },
      { type: EventType.RUN_ERROR, threadId: "t", runId: "r", message: "boom" },
    ] as AGUIEvent[]);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      id: "m1",
      text: "Let",
      thinking: "second thoughts",
    });
  });

  it("carries reasoning on a turn that produced no assistant message", () => {
    // Reasoning, then tool calls, then the run ends. There is no message to
    // hang the thinking off, so the fold opens one rather than dropping it.
    const entries = foldAgui([
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "r1",
        delta: "plan the call",
      },
      { type: EventType.TOOL_CALL_START, toolCallId: "c1", toolCallName: "ls" },
      { type: EventType.TOOL_CALL_RESULT, toolCallId: "c1", content: "ok" },
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "run_7" },
    ] as AGUIEvent[]);
    const message = entries.find((e) => e.kind === "message");
    expect(message).toMatchObject({
      id: "run_7:reasoning",
      role: "assistant",
      text: "",
      thinking: "plan the call",
    });
  });

  it("adds nothing when there is no buffered reasoning to flush", () => {
    const entries = foldAgui([
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "m1",
        role: "assistant",
      },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: "Go." },
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" },
    ] as AGUIEvent[]);
    expect(entries).toHaveLength(1);
    expect((entries[0] as { thinking?: string }).thinking).toBeUndefined();
  });

  it("aliases a live message id via introspection.message_identity", () => {
    const entries = foldAgui([
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "run-1:text:0",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "run-1:text:0",
        delta: "answer",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "run-1:text:0" },
      {
        type: EventType.CUSTOM,
        name: "introspection.message_identity",
        value: { messageId: "run-1:text:0", responseId: "resp-1" },
      },
    ] as AGUIEvent[]);
    expect(entries[0]).toMatchObject({
      id: "run-1:text:0",
      responseId: "resp-1",
    });
  });

  it("reads the tool result error bit and closes leftovers on RUN_FINISHED", () => {
    const failed = foldAgui([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "c-err",
        toolCallName: "shell",
      },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "m",
        toolCallId: "c-err",
        content: "denied",
        isError: true,
      },
    ] as AGUIEvent[]);
    expect(failed[0]).toMatchObject({ callId: "c-err", status: "error" });

    // A RUN_FINISHED that leaves a generic tool open is an incomplete
    // protocol and closes it as error (§7h).
    const leftover = foldAgui([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "c-open",
        toolCallName: "shell",
      },
      { type: EventType.RUN_FINISHED, threadId: "t", runId: "r" },
    ] as AGUIEvent[]);
    expect(leftover[0]).toMatchObject({ callId: "c-open", status: "error" });
  });

  it("folds an agent start call into a delegation entry", () => {
    const entries = foldAgui([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "c-agent",
        toolCallName: "agent",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "c-agent",
        delta: '{"name":"researcher","label":"Research X"}',
      },
      { type: EventType.TOOL_CALL_END, toolCallId: "c-agent" },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "m",
        toolCallId: "c-agent",
        content: JSON.stringify({
          details: {
            agent: { agent_run_id: "child-run-1", status: "running" },
          },
        }),
      },
    ] as AGUIEvent[]);
    // Launched, not finished: the result contributes the invocation id and
    // the entry stays running until the child terminates (§7f).
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "delegation",
      id: "delegation-tool:c-agent",
      sourceToolCallId: "c-agent",
      invocationId: "child-run-1",
      agentName: "researcher",
      label: "Research X",
      status: "running",
    });
  });

  it("keeps non-start agent actions as ordinary tool calls", () => {
    const entries = foldAgui([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "c-status",
        toolCallName: "agent",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "c-status",
        delta: '{"action":"status"}',
      },
      { type: EventType.TOOL_CALL_END, toolCallId: "c-status" },
    ] as AGUIEvent[]);
    expect(entries[0]).toMatchObject({ kind: "tool", name: "agent" });
  });

  it("upserts MESSAGES_SNAPSHOT as a baseline without duplicating", () => {
    const entries = foldAgui([
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          { id: "m1", role: "assistant", content: "hydrated" },
          {
            id: "m2",
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "c1",
                function: { name: "shell", arguments: "{}" },
              },
            ],
          },
        ],
      },
      { type: EventType.TEXT_MESSAGE_CHUNK, messageId: "m1", delta: "!" },
    ] as AGUIEvent[]);
    expect(entries.filter((e) => e.kind === "message")).toHaveLength(2);
    expect(entries[0]).toMatchObject({ id: "m1", text: "hydrated!" });
    expect(entries.find((e) => e.kind === "tool")).toMatchObject({
      callId: "c1",
      name: "shell",
    });
  });

  it("routes activity and control frames to callbacks, not the transcript", () => {
    const activity: AGUIEvent[] = [];
    const control: AGUIEvent[] = [];
    const acc = new TranscriptAccumulator({
      onActivity: (e) => activity.push(e),
      onControl: (e) => control.push(e),
    });
    acc.push({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "a",
      snapshot: [],
    } as unknown as AGUIEvent);
    acc.push({
      type: EventType.CUSTOM,
      name: "run_lifecycle",
      value: { phase: "thinking" },
    } as AGUIEvent);
    expect(acc.entries).toHaveLength(0);
    expect(activity).toHaveLength(1);
    expect(control).toHaveLength(1);
  });
});

describe("mergeTranscripts", () => {
  it("collides live entries with their stored twins and keeps unmatched ones", () => {
    // Live message id equals the stored responseId (the runtime streams the
    // provider response id as messageId), and the live tool shares callId.
    const stored = foldSpans([chatSpan(), EXECUTE_TOOL_SPAN, TOOL_RESULT_SPAN]);
    const live = foldAgui([
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "resp-1",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "resp-1",
        delta: "Here",
      },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "call-1",
        toolCallName: "shell",
      },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "resp-3",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "resp-3",
        delta: "Still streaming",
      },
    ] as AGUIEvent[]);

    const merged = mergeTranscripts(stored, live);
    // Everything stored survives untouched; the only live addition is the
    // not-yet-persisted resp-3.
    expect(merged.slice(0, stored.length)).toEqual(stored);
    const extras = merged.slice(stored.length);
    expect(extras).toHaveLength(1);
    expect(extras[0]).toMatchObject({ id: "resp-3", text: "Still streaming" });
  });

  it("collides a live message with its stored twin through any alias", () => {
    // The live id is transport-local (`{runId}:text:0`); the
    // message_identity frame gave it the responseId its hydrated twin
    // folds under (§7c) — correlation must read aliases on *both* sides.
    const stored: TranscriptEntry[] = [
      {
        kind: "message",
        id: "resp-1",
        role: "assistant",
        text: "answer",
        responseId: "resp-1",
      },
    ];
    const live: TranscriptEntry[] = [
      {
        kind: "message",
        id: "run-1:text:0",
        role: "assistant",
        text: "answer",
        responseId: "resp-1",
      },
    ];
    expect(mergeTranscripts(stored, live)).toHaveLength(1);
  });

  it("correlates delegations by invocation, not agent role", () => {
    // Two invocations of the same researcher are two entries (§7g); a live
    // launch collides with its stored wrapper through the invocation id.
    const stored: TranscriptEntry[] = [
      {
        kind: "delegation",
        id: "span:w1:delegation",
        invocationId: "child-run-1",
        agentId: "researcher:abc",
        status: "complete",
      },
      {
        kind: "delegation",
        id: "span:w2:delegation",
        invocationId: "child-run-2",
        agentId: "researcher:abc",
        status: "complete",
      },
    ];
    const live: TranscriptEntry[] = [
      {
        kind: "delegation",
        id: "delegation-tool:c1",
        sourceToolCallId: "c1",
        invocationId: "child-run-2",
        agentName: "researcher",
        status: "running",
      },
      {
        kind: "delegation",
        id: "delegation-tool:c2",
        sourceToolCallId: "c2",
        invocationId: "child-run-3",
        agentName: "researcher",
        status: "running",
      },
    ];
    const merged = mergeTranscripts(stored, live);
    expect(merged).toHaveLength(3);
    expect(merged[2]).toMatchObject({ invocationId: "child-run-3" });
  });

  it("falls back to agent id only when neither side has an invocation id", () => {
    const stored: TranscriptEntry[] = [
      {
        kind: "delegation",
        id: "span:x:delegation",
        agentId: "researcher:abc",
        status: "complete",
      },
    ];
    const live: TranscriptEntry[] = [
      {
        kind: "delegation",
        id: "live-d",
        agentId: "researcher:abc",
        status: "running",
      },
      {
        kind: "delegation",
        id: "live-e",
        agentId: "writer:def",
        status: "running",
      },
      {
        // Carries an invocation id, so the legacy agent-id fallback must
        // NOT swallow it even though the role matches.
        kind: "delegation",
        id: "live-f",
        invocationId: "child-run-9",
        agentId: "researcher:abc",
        status: "running",
      },
    ];
    const merged = mergeTranscripts(stored, live);
    expect(merged).toHaveLength(3);
    expect(merged[1]).toMatchObject({ agentId: "writer:def" });
    expect(merged[2]).toMatchObject({ invocationId: "child-run-9" });
  });
});
