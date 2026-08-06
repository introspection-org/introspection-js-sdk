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
      agent: { parent_id: "root-1", invocation_id: "child-run-1" },
    },
  },
};

describe("foldSpans", () => {
  it("folds a turn with assistant content before its requested tools", () => {
    // Pages arrive newest-first; the fold owns chronological order.
    const entries = foldSpans([
      TOOL_RESULT_SPAN,
      DELEGATION_SPAN,
      EXECUTE_TOOL_SPAN,
      chatSpan(),
    ]);

    expect(entries.map((e) => e.kind)).toEqual([
      "message", // user
      "message", // assistant resp-1
      "tool", // call-1, after the assistant content that requested it
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
      id: "delegation:child-run-1",
      agentId: "researcher:abc",
      agentName: "researcher",
      invocationId: "child-run-1",
      status: "complete",
      durationNs: 9_500_000_000,
    });
    expect(followUp).toMatchObject({ id: "resp-2", text: "Done." });
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

  it("keeps requested and in-progress tools running until an outcome arrives", () => {
    const requested = foldSpans([chatSpan()]).find(
      (entry) => entry.kind === "tool",
    );
    expect(requested).toMatchObject({ callId: "call-1", status: "running" });

    const executing = foldSpans([EXECUTE_TOOL_SPAN]).find(
      (entry) => entry.kind === "tool",
    );
    expect(executing).toMatchObject({ callId: "call-1", status: "running" });

    const finished = foldSpans([
      chatSpan(),
      { ...EXECUTE_TOOL_SPAN, end_time: "2026-01-01T00:00:03Z" },
    ]).find((entry) => entry.kind === "tool");
    expect(finished).toMatchObject({ callId: "call-1", status: "complete" });
  });

  it("preserves stored tool-result errors", () => {
    const erroredResult: GenAiSpan = {
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
                    response: { isError: true, error: "failed" },
                  },
                ],
              },
            ],
          },
        },
      },
    };

    const tool = foldSpans([chatSpan(), erroredResult]).find(
      (entry) => entry.kind === "tool",
    );
    expect(tool).toMatchObject({ callId: "call-1", status: "error" });
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

  it("applies reasoning to the open or next assistant message", () => {
    const entries = foldAgui([
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "old",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "old",
        delta: "Finished",
      },
      { type: EventType.TEXT_MESSAGE_END, messageId: "old" },
      { type: EventType.REASONING_START, messageId: "reasoning-1" },
      {
        type: EventType.REASONING_MESSAGE_CONTENT,
        messageId: "reasoning-1",
        delta: "new thought",
      },
      { type: EventType.REASONING_END, messageId: "reasoning-1" },
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "new",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "new",
        delta: "New answer",
      },
    ] as AGUIEvent[]);

    expect(entries[0]).toMatchObject({ id: "old", text: "Finished" });
    expect(entries[0]).not.toHaveProperty("thinking");
    expect(entries[1]).toMatchObject({
      id: "new",
      text: "New answer",
      thinking: "new thought",
    });
  });

  it("replaces snapshot state before applying later deltas", () => {
    const acc = new TranscriptAccumulator();
    acc.push({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        { id: "stale", role: "assistant", content: "stale answer" },
        {
          id: "stale-tool-message",
          role: "tool",
          toolCallId: "stale-call",
          content: "old",
        },
      ],
    } as AGUIEvent);
    acc.push({
      type: EventType.MESSAGES_SNAPSHOT,
      messages: [
        { id: "user-1", role: "user", content: "question" },
        { id: "reasoning-1", role: "reasoning", content: "thinking" },
        {
          id: "assistant-1",
          role: "assistant",
          content: "answer",
          toolCalls: [
            {
              id: "call-1",
              type: "function",
              function: { name: "search", arguments: '{"q":"x"}' },
            },
          ],
        },
      ],
    } as AGUIEvent);
    acc.push({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "assistant-1",
      delta: " continued",
    } as AGUIEvent);

    expect(acc.entries).toHaveLength(3);
    expect(acc.entries.some((entry) => entry.id === "stale")).toBe(false);
    expect(acc.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "user-1", text: "question" }),
        expect.objectContaining({
          id: "assistant-1",
          text: "answer continued",
          thinking: "thinking",
        }),
        expect.objectContaining({
          callId: "call-1",
          name: "search",
          status: "running",
        }),
      ]),
    );
  });

  it("keeps activity and control frames on explicit side channels", () => {
    const activities: AGUIEvent[] = [];
    const controls: AGUIEvent[] = [];
    const acc = new TranscriptAccumulator({
      onActivity: (event) => activities.push(event),
      onControl: (event) => controls.push(event),
    });

    acc.push({
      type: EventType.ACTIVITY_SNAPSHOT,
      messageId: "activity-1",
      activityType: "progress",
      content: { label: "Searching" },
      replace: true,
    } as AGUIEvent);
    acc.push({
      type: EventType.CUSTOM,
      name: "introspection.resume_gap",
      value: { recoverable: true },
    } as AGUIEvent);
    acc.push({
      type: EventType.RUN_FINISHED,
      threadId: "thread-1",
      runId: "run-1",
    } as AGUIEvent);

    expect(acc.entries).toEqual([]);
    expect(activities).toHaveLength(1);
    expect(controls.map((event) => event.type)).toEqual([
      EventType.CUSTOM,
      EventType.RUN_FINISHED,
    ]);
  });

  it("keeps tools running at TOOL_CALL_END and honors result errors", () => {
    const acc = new TranscriptAccumulator();
    acc.push({
      type: EventType.TOOL_CALL_START,
      toolCallId: "call-error",
      toolCallName: "shell",
    } as AGUIEvent);
    acc.push({
      type: EventType.TOOL_CALL_END,
      toolCallId: "call-error",
    } as AGUIEvent);
    expect(acc.entries[0]).toMatchObject({ status: "running" });

    acc.push({
      type: EventType.TOOL_CALL_RESULT,
      messageId: "tool-result",
      toolCallId: "call-error",
      content: "command failed",
      isError: true,
    } as AGUIEvent);
    expect(acc.entries[0]).toMatchObject({ status: "error" });
  });

  it("projects agent starts as delegations and keeps management calls as tools", () => {
    const entries = foldAgui([
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "call-start",
        toolCallName: "agent",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "call-start",
        delta:
          '{"name":"researcher","prompt":"research","label":"Market scan"}',
      },
      { type: EventType.TOOL_CALL_END, toolCallId: "call-start" },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "result-start",
        toolCallId: "call-start",
        content: JSON.stringify({
          details: {
            agent: {
              agent_run_id: "child-run-1",
              agent_name: "researcher",
              label: "Market scan",
              status: "running",
            },
          },
        }),
      },
      {
        type: EventType.TOOL_CALL_START,
        toolCallId: "call-status",
        toolCallName: "agent",
      },
      {
        type: EventType.TOOL_CALL_ARGS,
        toolCallId: "call-status",
        delta: '{"action":"status","id":"child-run-1"}',
      },
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: "result-status",
        toolCallId: "call-status",
        content: "status",
      },
    ] as AGUIEvent[]);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      kind: "delegation",
      id: "delegation-tool:call-start",
      sourceToolCallId: "call-start",
      invocationId: "child-run-1",
      agentName: "researcher",
      label: "Market scan",
      status: "running",
    });
    expect(entries[1]).toMatchObject({
      kind: "tool",
      callId: "call-status",
      name: "agent",
      status: "complete",
    });
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

  it("dedupes delegations by invocation and preserves repeated agent calls", () => {
    const stored: TranscriptEntry[] = [
      {
        kind: "delegation",
        id: "span:x:delegation",
        agentId: "researcher:abc",
        invocationId: "invocation-1",
        status: "complete",
      },
    ];
    const live: TranscriptEntry[] = [
      {
        kind: "delegation",
        id: "live-d",
        agentId: "researcher:abc",
        invocationId: "invocation-1",
        status: "running",
      },
      {
        kind: "delegation",
        id: "live-e",
        agentId: "researcher:abc",
        invocationId: "invocation-2",
        status: "running",
      },
    ];
    const merged = mergeTranscripts(stored, live);
    expect(merged).toHaveLength(2);
    expect(merged[1]).toMatchObject({
      agentId: "researcher:abc",
      invocationId: "invocation-2",
    });
  });

  it("uses runtime identity aliases to reconcile connection-local ids", () => {
    const stored = foldSpans([chatSpan()]);
    const live = foldAgui([
      {
        type: EventType.TEXT_MESSAGE_START,
        messageId: "run-1:text:0",
        role: "assistant",
      },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "run-1:text:0",
        delta: "Here are the results.",
      },
      {
        type: EventType.CUSTOM,
        name: "introspection.message_identity",
        value: { messageId: "run-1:text:0", responseId: "resp-1" },
      },
    ] as AGUIEvent[]);

    expect(live[0]).toMatchObject({
      id: "run-1:text:0",
      responseId: "resp-1",
    });
    expect(mergeTranscripts(stored, live)).toEqual(stored);
  });
});
