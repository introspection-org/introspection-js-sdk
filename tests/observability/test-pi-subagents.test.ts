/**
 * Tests for the Pi Agent SDK multi-agent subagent pattern.
 *
 * Covers IntrospectionPiInstrumentor with multiple agents, each carrying
 * distinct AgentMeta (agentName, agentId, conversationId), matching the
 * pattern in examples/otel/pi/subagents.ts.
 *
 * Uses mock streams — no real API calls, no Polly recordings needed.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { trace } from "@opentelemetry/api";
import { IntrospectionPiInstrumentor } from "@introspection-sdk/introspection-node/otel/pi";
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
  instrumentStream,
  type AgentMeta,
} from "../../packages/introspection-pi/src";

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

function makeAssistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "Done." }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: {
      input: 50,
      output: 10,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 60,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
  };
}

function setupTracer() {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  return { exporter, provider, tracer: provider.getTracer("pi-subagent-test") };
}

function makeMockStreamFn() {
  return vi.fn(() => {
    const stream = createAssistantMessageEventStream();
    stream.push({
      type: "done",
      reason: "stop",
      message: makeAssistantMessage(),
    });
    return stream;
  });
}

describe("Pi Subagents — distinct AgentMeta per instrumented agent", () => {
  afterEach(() => {
    // Each test creates its own provider — nothing to clean up globally.
  });

  it("emits spans with the correct conversation ID and agent name per agent", async () => {
    const { exporter, provider, tracer } = setupTracer();

    const ORCHESTRATOR: AgentMeta = {
      agentName: "orchestrator",
      agentId: "orchestrator-main",
      conversationId: "pi-orch-conv-test",
    };
    const RESEARCHER: AgentMeta = {
      agentName: "researcher",
      agentId: "researcher-primes",
      conversationId: "pi-researcher-conv-test",
    };

    const orchStreamFn = makeMockStreamFn();
    const researcherStreamFn = makeMockStreamFn();

    const wrappedOrch = instrumentStream(orchStreamFn, {
      tracer,
      meta: ORCHESTRATOR,
    });
    const wrappedResearcher = instrumentStream(researcherStreamFn, {
      tracer,
      meta: RESEARCHER,
    });

    // Orchestrator: phase 1
    const orchStream1 = wrappedOrch(MODEL, {
      systemPrompt: "Dispatch tasks.",
      messages: [{ role: "user", content: "List tasks.", timestamp: 0 }],
    });
    await orchStream1.result();

    // Researcher: processes a task
    const researcherStream = wrappedResearcher(MODEL, {
      systemPrompt: "Research primes.",
      messages: [{ role: "user", content: "Explain primes.", timestamp: 0 }],
    });
    await researcherStream.result();

    // Orchestrator: phase 3 — same wrappedOrch, same AgentMeta → same conversation ID
    const orchStream2 = wrappedOrch(MODEL, {
      systemPrompt: "Synthesise.",
      messages: [{ role: "user", content: "Summarise.", timestamp: 0 }],
    });
    await orchStream2.result();

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThanOrEqual(3);

    const orchSpans = spans.filter(
      (s) => s.attributes["gen_ai.conversation.id"] === "pi-orch-conv-test",
    );
    const researcherSpans = spans.filter(
      (s) =>
        s.attributes["gen_ai.conversation.id"] === "pi-researcher-conv-test",
    );

    // Orchestrator phases 1 and 3 share the same conversation ID
    expect(orchSpans.length).toBe(2);
    // Researcher has its own conversation ID
    expect(researcherSpans.length).toBe(1);

    // Agent names are set from AgentMeta
    for (const span of orchSpans) {
      expect(span.attributes["gen_ai.agent.name"]).toBe("orchestrator");
      expect(span.attributes["gen_ai.agent.id"]).toBe("orchestrator-main");
    }
    expect(researcherSpans[0].attributes["gen_ai.agent.name"]).toBe(
      "researcher",
    );
    expect(researcherSpans[0].attributes["gen_ai.agent.id"]).toBe(
      "researcher-primes",
    );
  });

  it("parallel agents produce non-overlapping spans with distinct conversation IDs", async () => {
    const { exporter, provider, tracer } = setupTracer();

    const PRIMES: AgentMeta = {
      agentName: "researcher",
      agentId: "researcher-primes",
      conversationId: "pi-primes-conv-test",
    };
    const FIB: AgentMeta = {
      agentName: "researcher",
      agentId: "researcher-fib",
      conversationId: "pi-fib-conv-test",
    };

    const primesStream = instrumentStream(makeMockStreamFn(), {
      tracer,
      meta: PRIMES,
    });
    const fibStream = instrumentStream(makeMockStreamFn(), {
      tracer,
      meta: FIB,
    });

    // Run both in parallel — AsyncLocalStorage keeps spans isolated
    await Promise.all([
      primesStream(MODEL, {
        messages: [{ role: "user", content: "Explain primes.", timestamp: 0 }],
      }).result(),
      fibStream(MODEL, {
        messages: [
          { role: "user", content: "Explain Fibonacci.", timestamp: 0 },
        ],
      }).result(),
    ]);

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(2);

    const primesSpan = spans.find(
      (s) => s.attributes["gen_ai.conversation.id"] === "pi-primes-conv-test",
    );
    const fibSpan = spans.find(
      (s) => s.attributes["gen_ai.conversation.id"] === "pi-fib-conv-test",
    );

    expect(primesSpan).toBeDefined();
    expect(fibSpan).toBeDefined();

    // Same agent name, different agent IDs and conversation IDs
    expect(primesSpan?.attributes["gen_ai.agent.id"]).toBe("researcher-primes");
    expect(fibSpan?.attributes["gen_ai.agent.id"]).toBe("researcher-fib");
  });
});

describe("IntrospectionPiInstrumentor lifecycle", () => {
  /** A stand-in Agent: only what the instrumentor touches. */
  function fakeAgent(streamFn: ReturnType<typeof makeMockStreamFn>) {
    return {
      streamFunction: streamFn,
      subscribe: () => () => {},
    } as unknown as Parameters<IntrospectionPiInstrumentor["instrument"]>[0];
  }

  const META: AgentMeta = {
    agentName: "worker",
    agentId: "w-1",
    conversationId: "conv-1",
  };

  it("replaces instrumentation instead of stacking it", async () => {
    const { exporter, provider } = setupTracer();
    trace.setGlobalTracerProvider(provider);
    const instrumentor = new IntrospectionPiInstrumentor();
    const streamFn = makeMockStreamFn();
    const agent = fakeAgent(streamFn);

    // AgentMeta carries the conversation id, so a host reusing one Agent
    // across conversations calls this again by design. Double-wrapping
    // produced two chat spans per call, the inner one stamped with the
    // previous conversation.
    instrumentor.instrument(agent, META);
    instrumentor.instrument(agent, { ...META, conversationId: "conv-2" });

    await (agent as unknown as { streamFunction: typeof streamFn })
      .streamFunction(MODEL, {
        systemPrompt: "go",
        messages: [{ role: "user", content: "hi", timestamp: 0 }],
      })
      .result();

    const chats = exporter
      .getFinishedSpans()
      .filter((s) => s.name.startsWith("chat"));
    expect(chats).toHaveLength(1);
    expect(chats[0]?.attributes["gen_ai.conversation.id"]).toBe("conv-2");
    instrumentor.stop();
  });

  it("puts the original stream function back on stop", async () => {
    const { exporter, provider } = setupTracer();
    trace.setGlobalTracerProvider(provider);
    const instrumentor = new IntrospectionPiInstrumentor();
    const streamFn = makeMockStreamFn();
    const agent = fakeAgent(streamFn);

    instrumentor.instrument(agent, META);
    instrumentor.stop();

    await (agent as unknown as { streamFunction: typeof streamFn })
      .streamFunction(MODEL, {
        systemPrompt: "go",
        messages: [{ role: "user", content: "hi", timestamp: 0 }],
      })
      .result();

    // A stopped instrumentor's agents used to keep emitting forever, onto a
    // provider that may already be shut down.
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
