/**
 * End-to-end-ish tests for `instrumentStream` and `instrumentAgent`.
 *
 * Uses the OTel `BasicTracerProvider` + `InMemorySpanExporter` (the same
 * pattern other tests in this repo use) so we can introspect the spans
 * emitted by the wrappers without a real backend.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  context as otelContext,
  trace,
  type Context as OtelContext,
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import {
  instrumentAgent,
  instrumentStream,
  type AgentMeta,
} from "../../packages/introspection-pi/src";

const META: AgentMeta = {
  conversationId: "conv_123",
  agentId: "agent-1",
  agentName: "Test Agent",
};

const MODEL: Model<"anthropic-messages"> = {
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
};

function setupTracer() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { exporter, provider, tracer: provider.getTracer("pi-agent-test") };
}

function assistantMessage(
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Done." }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: {
      input: 100,
      output: 20,
      cacheRead: 50,
      cacheWrite: 0,
      totalTokens: 170,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: 0,
  };
}

afterEach(() => {
  // Each test creates its own provider; nothing to clean up globally.
});

describe("instrumentStream", () => {
  it("emits a chat span with the GenAI request + response attributes", async () => {
    const { exporter, tracer, provider } = setupTracer();

    const upstream = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "start",
        partial: assistantMessage(),
      });
      stream.push({
        type: "done",
        reason: "stop",
        message: assistantMessage(),
      });
      return stream;
    });

    const wrapped = instrumentStream(upstream, { tracer, meta: META });
    const stream = wrapped(
      MODEL,
      {
        systemPrompt: "Be concise.",
        messages: [{ role: "user", content: "Inspect", timestamp: 0 }],
      },
      {
        temperature: 0.2,
        maxTokens: 1024,
        reasoning: "high",
      },
    );
    await stream.result();
    await provider.forceFlush();

    const span = exporter
      .getFinishedSpans()
      .find((candidate) => candidate.name === "chat anthropic");
    expect(span).toBeDefined();
    expect(span?.attributes["gen_ai.conversation.id"]).toBe("conv_123");
    expect(span?.attributes["gen_ai.request.model"]).toBe("claude-sonnet-4-6");
    expect(span?.attributes["gen_ai.request.stream"]).toBe(true);
    expect(span?.attributes["gen_ai.request.temperature"]).toBe(0.2);
    expect(span?.attributes["gen_ai.request.max_tokens"]).toBe(1024);
    expect(span?.attributes["gen_ai.request.reasoning.level"]).toBe("high");
    expect(typeof span?.attributes["gen_ai.response.time_to_first_chunk"]).toBe(
      "number",
    );
    expect(span?.attributes["gen_ai.usage.input_tokens"]).toBe(100);
    expect(span?.attributes["gen_ai.usage.cache_read.input_tokens"]).toBe(50);
    expect(
      span?.attributes["gen_ai.usage.cache_creation.input_tokens"],
    ).toBeUndefined();
    expect(
      JSON.parse(String(span?.attributes["gen_ai.input.messages"])),
    ).toEqual([
      { role: "user", parts: [{ type: "text", content: "Inspect" }] },
    ]);
    expect(span?.status.code).toBe(1); // SpanStatusCode.OK
  });

  it("invokes extraAttributes and merges its output onto the chat span", async () => {
    const { exporter, tracer, provider } = setupTracer();

    const upstream = vi.fn(() => {
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "stop",
        message: assistantMessage(),
      });
      return stream;
    });

    const wrapped = instrumentStream(upstream, {
      tracer,
      meta: META,
      extraAttributes: () => ({
        "introspection.byok": true,
        "introspection.client_message_id": "msg_42",
      }),
    });
    await wrapped(MODEL, {
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
    }).result();
    await provider.forceFlush();

    const span = exporter
      .getFinishedSpans()
      .find((candidate) => candidate.name === "chat anthropic");
    expect(span?.attributes["introspection.byok"]).toBe(true);
    expect(span?.attributes["introspection.client_message_id"]).toBe("msg_42");
  });

  it("parents the chat span on the context returned by getParentContext", async () => {
    const { exporter, tracer, provider } = setupTracer();

    let parentTraceId = "";
    let parentSpanId = "";
    let parentContext: OtelContext | null = null;

    await tracer.startActiveSpan("turn", async (parent) => {
      parentTraceId = parent.spanContext().traceId;
      parentSpanId = parent.spanContext().spanId;
      parentContext = trace.setSpan(otelContext.active(), parent);

      const upstream = () => {
        const stream = createAssistantMessageEventStream();
        stream.push({
          type: "done",
          reason: "stop",
          message: assistantMessage(),
        });
        return stream;
      };
      const wrapped = instrumentStream(upstream, {
        tracer,
        meta: META,
        getParentContext: () => parentContext,
      });
      await wrapped(MODEL, {
        messages: [{ role: "user", content: "hi", timestamp: 0 }],
      }).result();
      parent.end();
    });

    await provider.forceFlush();
    const chat = exporter
      .getFinishedSpans()
      .find((s) => s.name === "chat anthropic");
    expect(chat?.spanContext().traceId).toBe(parentTraceId);
    expect(chat?.parentSpanContext?.spanId).toBe(parentSpanId);
  });

  it("records the model error and closes the span when the stream ends in error", async () => {
    const { exporter, tracer, provider } = setupTracer();

    const upstream = () => {
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "error",
        reason: "error",
        error: { ...assistantMessage("error"), errorMessage: "boom" },
      });
      return stream;
    };

    const wrapped = instrumentStream(upstream, { tracer, meta: META });
    const stream = wrapped(MODEL, {
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
    });
    await stream.result();
    await provider.forceFlush();

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "chat anthropic");
    expect(span?.status.code).toBe(2); // ERROR
    expect(span?.status.message).toBe("boom");
    expect(span?.attributes["error.type"]).toBe("model_error");
    expect(span?.events.some((e) => e.name === "exception")).toBe(true);
    expect(
      span?.events.some((e) => e.name === "gen_ai.client.operation.exception"),
    ).toBe(true);
  });

  it("treats an aborted stream as a manual terminal state, not an error", async () => {
    const { exporter, tracer, provider } = setupTracer();

    const upstream = () => {
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "error",
        reason: "aborted",
        error: {
          ...assistantMessage("aborted"),
          errorMessage: "Request was aborted",
        },
      });
      return stream;
    };

    const wrapped = instrumentStream(upstream, { tracer, meta: META });
    await wrapped(MODEL, {
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
    }).result();
    await provider.forceFlush();

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "chat anthropic");
    expect(span?.status.code).toBe(0); // UNSET — manual abort, not success or failure
    expect(span?.attributes["gen_ai.response.finish_reasons"]).toEqual([
      "aborted",
    ]);
    expect(span?.attributes["error.type"]).toBeUndefined();
    expect(span?.events.some((e) => e.name === "exception")).toBe(false);
    expect(
      span?.events.some((e) => e.name === "gen_ai.client.operation.exception"),
    ).toBe(false);
  });

  it("classifies an aborted stream as cancelled, not an error, by default", async () => {
    const { exporter, tracer, provider } = setupTracer();

    const upstream = () => {
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "error",
        reason: "aborted",
        error: {
          ...assistantMessage("aborted"),
          errorMessage: "Request was aborted",
        },
      });
      return stream;
    };

    const wrapped = instrumentStream(upstream, { tracer, meta: META });
    await wrapped(MODEL, {
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
    }).result();
    await provider.forceFlush();

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "chat anthropic");
    expect(span?.status.code).toBe(0); // UNSET — not a failure, not asserted success
    expect(span?.events.some((e) => e.name === "exception")).toBe(false);
    expect(span?.attributes["introspection.termination_reason"]).toBe(
      "cancelled",
    );
    // The mechanical stop reason stays queryable on the span.
    expect(span?.attributes["gen_ai.response.finish_reasons"]).toEqual([
      "aborted",
    ]);
  });

  it("stamps the abortTerminationReason callback's value on aborted spans", async () => {
    const { exporter, tracer, provider } = setupTracer();

    const upstream = () => {
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "error",
        reason: "aborted",
        error: {
          ...assistantMessage("aborted"),
          errorMessage: "Request was aborted",
        },
      });
      return stream;
    };

    const wrapped = instrumentStream(upstream, {
      tracer,
      meta: META,
      abortTerminationReason: () => "awaiting_user",
    });
    await wrapped(MODEL, {
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
    }).result();
    await provider.forceFlush();

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "chat anthropic");
    expect(span?.status.code).toBe(0); // UNSET
    expect(span?.attributes["introspection.termination_reason"]).toBe(
      "awaiting_user",
    );
  });

  it("keeps an abort classified as an error when abortTerminationReason returns null", async () => {
    const { exporter, tracer, provider } = setupTracer();

    const upstream = () => {
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "error",
        reason: "aborted",
        error: {
          ...assistantMessage("aborted"),
          errorMessage: "Request was aborted",
        },
      });
      return stream;
    };

    const wrapped = instrumentStream(upstream, {
      tracer,
      meta: META,
      abortTerminationReason: () => null,
    });
    await wrapped(MODEL, {
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
    }).result();
    await provider.forceFlush();

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "chat anthropic");
    expect(span?.status.code).toBe(2); // ERROR — unconfirmed abort fails loud
    expect(span?.status.message).toBe("Request was aborted");
    expect(span?.events.some((e) => e.name === "exception")).toBe(true);
    expect(
      span?.attributes["introspection.termination_reason"],
    ).toBeUndefined();
  });
});

describe("instrumentAgent", () => {
  // Minimal AgentLike that the instrumentAgent helper subscribes to. The
  // real pi Agent invokes listeners with (event, signal) — the run's
  // AbortSignal — so the fake threads an optional signal through.
  function fakeAgent() {
    const subscribers: Array<(event: unknown, signal?: AbortSignal) => void> =
      [];
    const agent = {
      subscribe(fn: (event: unknown, signal?: AbortSignal) => void) {
        subscribers.push(fn);
        return () => {
          const idx = subscribers.indexOf(fn);
          if (idx >= 0) subscribers.splice(idx, 1);
        };
      },
      emit(event: unknown, signal?: AbortSignal) {
        for (const fn of subscribers) fn(event, signal);
      },
    };
    return agent;
  }

  it("emits one execute_tool span per tool call with the documented attributes", async () => {
    const { exporter, tracer, provider } = setupTracer();
    const agent = fakeAgent();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = instrumentAgent(agent as any, { tracer, meta: META });

    agent.emit({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "shell",
      args: { cmd: "ls" },
    });
    agent.emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "shell",
      result: { stdout: "ok" },
      isError: false,
    });

    tools.stop();
    await provider.forceFlush();

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "execute_tool shell");
    expect(span).toBeDefined();
    expect(span?.attributes["gen_ai.operation.name"]).toBe("execute_tool");
    expect(span?.attributes["gen_ai.tool.name"]).toBe("shell");
    expect(span?.attributes["gen_ai.tool.call.id"]).toBe("call-1");
    expect(
      JSON.parse(String(span?.attributes["gen_ai.tool.call.arguments"])),
    ).toEqual({ cmd: "ls" });
    expect(
      JSON.parse(String(span?.attributes["gen_ai.tool.call.result"])),
    ).toEqual({ stdout: "ok" });
    expect(span?.status.code).toBe(1); // OK
  });

  it("invokes extraAttributes and merges its output onto the tool span", async () => {
    const { exporter, tracer, provider } = setupTracer();
    const agent = fakeAgent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = instrumentAgent(agent as any, {
      tracer,
      meta: META,
      extraAttributes: (event) => ({
        "introspection.run.id": `run-${event.toolCallId}`,
        "introspection.agent.invocation_index": 2,
      }),
    });

    agent.emit({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "shell",
      args: { cmd: "ls" },
    });
    agent.emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "shell",
      result: { stdout: "ok" },
      isError: false,
    });

    tools.stop();
    await provider.forceFlush();

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "execute_tool shell");
    expect(span?.attributes["introspection.run.id"]).toBe("run-call-1");
    expect(span?.attributes["introspection.agent.invocation_index"]).toBe(2);
  });

  it("marks the span as error and surfaces the result message when isError=true", async () => {
    const { exporter, tracer, provider } = setupTracer();
    const agent = fakeAgent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = instrumentAgent(agent as any, { tracer, meta: META });

    agent.emit({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "/tmp/missing" },
    });
    agent.emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "read",
      result: "ENOENT",
      isError: true,
    });

    tools.stop();
    await provider.forceFlush();

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "execute_tool read");
    expect(span?.status.code).toBe(2); // ERROR
    expect(span?.attributes["error.type"]).toBe("tool_error");
    expect(span?.status.message).toContain("ENOENT");
  });

  it("marks an errored tool end as cancelled when the run's abort signal fired", async () => {
    const { exporter, tracer, provider } = setupTracer();
    const agent = fakeAgent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = instrumentAgent(agent as any, { tracer, meta: META });

    const abortController = new AbortController();
    agent.emit(
      {
        type: "tool_execution_start",
        toolCallId: "call-1",
        toolName: "shell",
        args: { cmd: "sleep 999" },
      },
      abortController.signal,
    );
    abortController.abort();
    agent.emit(
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "shell",
        result: "Operation aborted",
        isError: true,
      },
      abortController.signal,
    );

    tools.stop();
    await provider.forceFlush();

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "execute_tool shell");
    expect(span?.status.code).toBe(0); // UNSET — cancelled, not failed
    expect(span?.attributes["introspection.termination_reason"]).toBe(
      "cancelled",
    );
    expect(span?.attributes["gen_ai.tool.call.result"]).toBe(
      "Operation aborted",
    );
  });

  it("stop() closes any tool spans still open (e.g. an aborted run)", async () => {
    const { exporter, tracer, provider } = setupTracer();
    const agent = fakeAgent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tools = instrumentAgent(agent as any, { tracer, meta: META });

    agent.emit({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "shell",
      args: { cmd: "sleep 999" },
    });

    tools.stop();
    await provider.forceFlush();

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "execute_tool shell");
    expect(span).toBeDefined();
    expect(span?.endTime).not.toEqual([0, 0]);
  });
});

// vitest's vi is auto-imported in vitest >= 1, but make it explicit here
// for editors / readers that don't pick it up from globals.
import { vi } from "vitest";
