/**
 * Tests for `instrumentSession` — the one-call session attach that wires
 * `instrumentStream` + `instrumentAgent` onto a live Pi agent session.
 */

import { describe, expect, it } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { trace, context as otelContext } from "@opentelemetry/api";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import {
  instrumentSession,
  type AgentMeta,
  type InstrumentableAgentSession,
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

function assistantMessage(): AssistantMessage {
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
    stopReason: "stop",
    timestamp: 0,
  };
}

function mockStreamFn() {
  return () => {
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: assistantMessage() });
    stream.push({
      type: "done",
      reason: "stop",
      message: assistantMessage(),
    });
    return stream;
  };
}

/**
 * A structural fake session. `streamKey` selects which generation of the
 * stream-function property the fake agent carries.
 */
function fakeSession(streamKey: "streamFn" | "streamFunction") {
  const subscribers: Array<(event: unknown) => void> = [];
  const agent: Record<string, unknown> = {
    state: { tools: [] },
    [streamKey]: mockStreamFn(),
    subscribe(fn: (event: unknown) => void) {
      subscribers.push(fn);
      return () => {
        const idx = subscribers.indexOf(fn);
        if (idx >= 0) subscribers.splice(idx, 1);
      };
    },
  };
  const session = {
    agent,
    sessionManager: { getEntries: () => [] as unknown[] },
  } as unknown as InstrumentableAgentSession;
  return {
    session,
    agent,
    emit: (event: unknown) => {
      for (const fn of [...subscribers]) fn(event);
    },
    callStream: async () => {
      const fn = agent[streamKey] as (
        model: unknown,
        context: unknown,
      ) => ReturnType<ReturnType<typeof mockStreamFn>>;
      await fn(MODEL, {
        messages: [{ role: "user", content: "hi", timestamp: 0 }],
      }).result();
    },
  };
}

describe("instrumentSession", () => {
  it("emits run + chat spans, nested, and detach restores the stream fn", async () => {
    const { exporter, tracer, provider } = setupTracer();
    const fake = fakeSession("streamFunction");
    const original = fake.agent.streamFunction;

    const handle = instrumentSession(fake.session, { tracer, meta: META });
    expect(fake.agent.streamFunction).not.toBe(original);

    fake.emit({ type: "agent_start" });
    await fake.callStream();
    fake.emit({ type: "agent_end", messages: [] });

    handle.detach();
    expect(fake.agent.streamFunction).toBe(original);
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const run = spans.find((s) => s.name === "invoke_agent Test Agent");
    const chat = spans.find((s) => s.name === "chat claude-sonnet-4-6");
    expect(run).toBeDefined();
    expect(chat).toBeDefined();
    expect(chat?.attributes["gen_ai.conversation.id"]).toBe("conv_123");
    expect(chat?.attributes["gen_ai.usage.output_tokens"]).toBe(20);
    expect(chat?.parentSpanContext?.spanId).toBe(run?.spanContext().spanId);
  });

  it("attaches across the streamFn property generation too", async () => {
    const { exporter, tracer, provider } = setupTracer();
    const fake = fakeSession("streamFn");

    const handle = instrumentSession(fake.session, { tracer, meta: META });
    await fake.callStream();
    handle.detach();
    await provider.forceFlush();

    expect(
      exporter
        .getFinishedSpans()
        .find((s) => s.name === "chat claude-sonnet-4-6"),
    ).toBeDefined();
  });

  it("hosts that own their span topology parent spans themselves", async () => {
    const { exporter, tracer, provider } = setupTracer();
    const fake = fakeSession("streamFunction");

    const turnSpan = tracer.startSpan("host_turn");
    const turnContext = trace.setSpan(otelContext.active(), turnSpan);
    const handle = instrumentSession(fake.session, {
      tracer,
      meta: META,
      runSpans: false,
      getParentContext: () => turnContext,
      extraAttributes: () => ({ "host.tenant": "org-1" }),
    });

    fake.emit({ type: "agent_start" });
    await fake.callStream();
    fake.emit({ type: "agent_end", messages: [] });
    handle.detach();
    turnSpan.end();
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    expect(
      spans.find((s) => s.name.startsWith("invoke_agent")),
    ).toBeUndefined();
    const chat = spans.find((s) => s.name === "chat claude-sonnet-4-6");
    expect(chat?.attributes["host.tenant"]).toBe("org-1");
    expect(chat?.parentSpanContext?.spanId).toBe(turnSpan.spanContext().spanId);
  });
});
