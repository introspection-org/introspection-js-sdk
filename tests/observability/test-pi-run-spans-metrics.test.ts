/**
 * Tests for the `invoke_agent` run spans and GenAI client metrics emitted by
 * `@introspection-sdk/introspection-pi`.
 */

import { describe, expect, it } from "vitest";
import { SpanKind, type Meter } from "@opentelemetry/api";
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
  return { exporter, provider, tracer: provider.getTracer("pi-test") };
}

interface MetricRecord {
  value: number;
  attributes?: Record<string, unknown>;
}

function fakeMeter() {
  const records: Record<string, MetricRecord[]> = {};
  const meter = {
    createHistogram(name: string) {
      records[name] ??= [];
      return {
        record(value: number, attributes?: Record<string, unknown>) {
          records[name]?.push({ value, attributes });
        },
      };
    },
  } as unknown as Meter;
  return { meter, records };
}

function fakeAgent(tools: Array<{ name: string; description?: string }> = []) {
  const subscribers: Array<(event: unknown, signal?: AbortSignal) => void> = [];
  return {
    state: { tools },
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
}

function assistantMessage(
  stopReason: AssistantMessage["stopReason"] = "stop",
  errorMessage?: string,
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
      cacheWrite: 5,
      totalTokens: 175,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage,
    timestamp: 0,
  };
}

describe("instrumentAgent — invoke_agent run spans", () => {
  it("emits an invoke_agent span with aggregated usage and finish reason", async () => {
    const { exporter, tracer, provider } = setupTracer();
    const agent = fakeAgent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = instrumentAgent(agent as any, {
      tracer,
      meta: META,
      runSpans: true,
    });

    agent.emit({ type: "agent_start" });
    expect(handle.getRunContext()).toBeDefined();
    agent.emit({ type: "message_end", message: assistantMessage("toolUse") });
    agent.emit({ type: "message_end", message: assistantMessage("stop") });
    agent.emit({ type: "agent_end", messages: [] });
    expect(handle.getRunContext()).toBeUndefined();

    handle.stop();
    await provider.forceFlush();

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "invoke_agent Test Agent");
    expect(span).toBeDefined();
    expect(span?.kind).toBe(SpanKind.INTERNAL);
    expect(span?.attributes["gen_ai.operation.name"]).toBe("invoke_agent");
    expect(span?.attributes["gen_ai.agent.name"]).toBe("Test Agent");
    expect(span?.attributes["gen_ai.agent.id"]).toBe("agent-1");
    expect(span?.attributes["gen_ai.conversation.id"]).toBe("conv_123");
    // No usage on the run span — platform aggregations sum every span in a
    // conversation, so run-span usage would double-count the chat spans.
    expect(span?.attributes["gen_ai.usage.input_tokens"]).toBeUndefined();
    expect(span?.attributes["gen_ai.usage.output_tokens"]).toBeUndefined();
    expect(span?.attributes["gen_ai.response.finish_reasons"]).toEqual([
      "stop",
    ]);
    // Multi-model agents: no request.model / provider on invoke_agent.
    expect(span?.attributes["gen_ai.request.model"]).toBeUndefined();
    expect(span?.attributes["gen_ai.provider.name"]).toBeUndefined();
    expect(span?.status.code).toBe(0); // UNSET
  });

  it("parents tool spans under the active run span", async () => {
    const { exporter, tracer, provider } = setupTracer();
    const agent = fakeAgent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = instrumentAgent(agent as any, {
      tracer,
      meta: META,
      runSpans: true,
    });

    agent.emit({ type: "agent_start" });
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
      result: "ok",
      isError: false,
    });
    agent.emit({ type: "agent_end", messages: [] });

    handle.stop();
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const run = spans.find((s) => s.name === "invoke_agent Test Agent");
    const tool = spans.find((s) => s.name === "execute_tool shell");
    expect(tool?.parentSpanContext?.spanId).toBe(run?.spanContext().spanId);
    expect(tool?.spanContext().traceId).toBe(run?.spanContext().traceId);
  });

  it("marks an errored run with ERROR status and error.type", async () => {
    const { exporter, tracer, provider } = setupTracer();
    const agent = fakeAgent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = instrumentAgent(agent as any, {
      tracer,
      meta: META,
      runSpans: true,
    });

    agent.emit({ type: "agent_start" });
    agent.emit({
      type: "message_end",
      message: assistantMessage("error", "429 rate limited"),
    });
    agent.emit({ type: "agent_end", messages: [] });
    handle.stop();
    await provider.forceFlush();

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "invoke_agent Test Agent");
    expect(span?.status.code).toBe(2); // ERROR
    // Provider-reported HTTP status is preferred over the coarse label.
    expect(span?.attributes["error.type"]).toBe("429");
    expect(span?.events.some((e) => e.name === "exception")).toBe(true);
  });

  it("marks an aborted run as cancelled, not an error", async () => {
    const { exporter, tracer, provider } = setupTracer();
    const agent = fakeAgent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = instrumentAgent(agent as any, {
      tracer,
      meta: META,
      runSpans: true,
    });

    agent.emit({ type: "agent_start" });
    agent.emit({ type: "message_end", message: assistantMessage("aborted") });
    agent.emit({ type: "agent_end", messages: [] });
    handle.stop();
    await provider.forceFlush();

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "invoke_agent Test Agent");
    expect(span?.status.code).toBe(0); // UNSET
    expect(span?.attributes["introspection.termination_reason"]).toBe(
      "cancelled",
    );
  });

  it("records gen_ai.tool.description from the agent's tool registry", async () => {
    const { exporter, tracer, provider } = setupTracer();
    const agent = fakeAgent([
      { name: "shell", description: "Run a shell command" },
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = instrumentAgent(agent as any, { tracer, meta: META });

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
      result: "ok",
      isError: false,
    });
    handle.stop();
    await provider.forceFlush();

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "execute_tool shell");
    expect(span?.attributes["gen_ai.tool.description"]).toBe(
      "Run a shell command",
    );
  });
});

describe("metrics", () => {
  it("records chat duration, time to first chunk, and token usage", async () => {
    const { tracer, provider } = setupTracer();
    const { meter, records } = fakeMeter();

    const upstream = () => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "start", partial: assistantMessage() });
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: "ok",
        partial: assistantMessage(),
      });
      stream.push({
        type: "done",
        reason: "stop",
        message: assistantMessage(),
      });
      return stream;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrapped = instrumentStream(upstream as any, {
      tracer,
      meta: META,
      meter,
    });
    await wrapped(MODEL, {
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
    }).result();
    await provider.forceFlush();

    const duration = records["gen_ai.client.operation.duration"];
    expect(duration).toHaveLength(1);
    expect(duration?.[0]?.attributes).toMatchObject({
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-sonnet-4-6",
      "gen_ai.response.model": "claude-sonnet-4-6",
      "server.address": "api.anthropic.com",
      "server.port": 443,
    });
    expect(duration?.[0]?.attributes?.["error.type"]).toBeUndefined();

    expect(records["gen_ai.client.operation.time_to_first_chunk"]).toHaveLength(
      1,
    );

    const tokens = records["gen_ai.client.token.usage"] ?? [];
    const input = tokens.find(
      (r) => r.attributes?.["gen_ai.token.type"] === "input",
    );
    const output = tokens.find(
      (r) => r.attributes?.["gen_ai.token.type"] === "output",
    );
    // Semconv input includes uncached and cache-read tokens.
    expect(input?.value).toBe(155);
    expect(output?.value).toBe(20);
  });

  it("stamps error.type on the duration metric for failed calls", async () => {
    const { tracer, provider } = setupTracer();
    const { meter, records } = fakeMeter();

    const upstream = () => {
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "error",
        reason: "error",
        error: assistantMessage("error", "boom"),
      });
      return stream;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrapped = instrumentStream(upstream as any, {
      tracer,
      meta: META,
      meter,
    });
    await wrapped(MODEL, {
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
    }).result();
    await provider.forceFlush();

    const duration = records["gen_ai.client.operation.duration"];
    expect(duration?.[0]?.attributes?.["error.type"]).toBe("model_error");
  });

  it("records execute_tool and invoke_agent durations", async () => {
    const { tracer, provider } = setupTracer();
    const { meter, records } = fakeMeter();
    const agent = fakeAgent();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handle = instrumentAgent(agent as any, {
      tracer,
      meta: META,
      meter,
      runSpans: true,
    });

    agent.emit({ type: "agent_start" });
    agent.emit({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "shell",
      args: {},
    });
    agent.emit({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "shell",
      result: "ok",
      isError: false,
    });
    agent.emit({ type: "agent_end", messages: [] });
    handle.stop();
    await provider.forceFlush();

    expect(records["gen_ai.execute_tool.duration"]).toHaveLength(1);
    expect(
      records["gen_ai.execute_tool.duration"]?.[0]?.attributes,
    ).toMatchObject({
      "gen_ai.tool.name": "shell",
      "gen_ai.tool.type": "function",
      "gen_ai.agent.name": "Test Agent",
    });
    expect(records["gen_ai.invoke_agent.duration"]).toHaveLength(1);
    expect(
      records["gen_ai.invoke_agent.duration"]?.[0]?.attributes,
    ).toMatchObject({ "gen_ai.agent.name": "Test Agent" });
  });
});

describe("chat span semconv upgrades", () => {
  it("uses CLIENT span kind, model-based name, and server attributes", async () => {
    const { exporter, tracer, provider } = setupTracer();

    const upstream = () => {
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "done",
        reason: "stop",
        message: assistantMessage(),
      });
      return stream;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrapped = instrumentStream(upstream as any, { tracer, meta: META });
    await wrapped(MODEL, {
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
    }).result();
    await provider.forceFlush();

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "chat claude-sonnet-4-6");
    expect(span).toBeDefined();
    expect(span?.kind).toBe(SpanKind.CLIENT);
    expect(span?.attributes["server.address"]).toBe("api.anthropic.com");
    expect(span?.attributes["server.port"]).toBe(443);
  });

  it("extracts an HTTP status from the provider error message as error.type", async () => {
    const { exporter, tracer, provider } = setupTracer();

    const upstream = () => {
      const stream = createAssistantMessageEventStream();
      stream.push({
        type: "error",
        reason: "error",
        error: assistantMessage("error", '429 {"error":"rate_limited"}'),
      });
      return stream;
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const wrapped = instrumentStream(upstream as any, { tracer, meta: META });
    await wrapped(MODEL, {
      messages: [{ role: "user", content: "hi", timestamp: 0 }],
    }).result();
    await provider.forceFlush();

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === "chat claude-sonnet-4-6");
    expect(span?.attributes["error.type"]).toBe("429");
    expect(span?.status.code).toBe(2); // ERROR
  });
});
