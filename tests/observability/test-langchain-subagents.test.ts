/**
 * Tests for the LangChain multi-agent subagent pattern.
 *
 * Covers the IntrospectionCallbackHandler identity propagation used in
 * examples/langchain/subagents.ts:
 *   - runName on a RunnableLambda → gen_ai.agent.name on enclosed LLM spans
 *   - metadata["gen_ai.conversation.id"] per invoke → per-agent conversation IDs
 *   - Parallel agents (Promise.all) produce distinct conversation IDs
 */

import { describe, it, expect, afterEach } from "vitest";
import { TestSpanExporter, simplifySpansForSnapshot } from "../testing";

async function getHandler(exporter: TestSpanExporter) {
  const { IntrospectionCallbackHandler } =
    await import("@introspection-sdk/introspection-node/langchain");
  return new IntrospectionCallbackHandler({
    advanced: { spanExporter: exporter, useSimpleSpanProcessor: true },
  });
}

describe("LangChain Subagents — identity propagation via handler", () => {
  let exporter: TestSpanExporter | null = null;
  let handler: Awaited<ReturnType<typeof getHandler>> | null = null;

  afterEach(async () => {
    if (handler) {
      await handler.shutdown();
      handler = null;
    }
    exporter = null;
  });

  it("stamps gen_ai.agent.name from the enclosing chain runName on LLM spans", async () => {
    exporter = new TestSpanExporter();
    handler = await getHandler(exporter);

    // RunnableLambda.withConfig({ runName }) calls handleChainStart with
    // the serialized chain having that name. The handler walks up the parent
    // run tree to find it and stamps gen_ai.agent.name on child LLM spans.
    handler.handleChainStart(
      { name: "orchestrator", id: ["orchestrator"] },
      {},
      "chain-1",
      undefined,
      undefined,
      { "gen_ai.conversation.id": "conv-orch-test" },
    );
    // The handler derives gen_ai.conversation.id from the LLM run's own
    // metadata, not by walking up to the parent chain. Pass it explicitly.
    handler.handleLLMStart(
      { name: "ChatAnthropic", id: ["ChatAnthropic"] },
      ["List 2 research tasks."],
      "llm-1",
      "chain-1",
      undefined,
      undefined,
      { "gen_ai.conversation.id": "conv-orch-test" },
    );
    handler.handleLLMEnd(
      {
        generations: [[{ text: "1. Primes 2. Fibonacci" }]],
        llmOutput: {
          usage: { input_tokens: 20, output_tokens: 8 },
        },
      },
      "llm-1",
    );
    handler.handleChainEnd({}, "chain-1");

    await handler.forceFlush();
    const spans = exporter.getFinishedSpans();
    const llmSpan = spans.find(
      (s) => s.attributes["gen_ai.operation.name"] === "chat",
    );

    expect(llmSpan).toBeDefined();
    expect(llmSpan?.attributes["gen_ai.agent.name"]).toBe("orchestrator");
    expect(llmSpan?.attributes["gen_ai.conversation.id"]).toBe(
      "conv-orch-test",
    );
  });

  it("assigns distinct conversation IDs to parallel agents via metadata", async () => {
    exporter = new TestSpanExporter();
    handler = await getHandler(exporter);

    const ORCH_CONV = "orch-conv-lc-test";
    const PRIMES_CONV = "primes-conv-lc-test";
    const FIB_CONV = "fib-conv-lc-test";

    // Orchestrator chain (phase 1)
    handler.handleChainStart(
      { name: "orchestrator", id: ["orchestrator"] },
      {},
      "orch-run",
      undefined,
      undefined,
      { "gen_ai.conversation.id": ORCH_CONV },
    );
    // Pass gen_ai.conversation.id on the LLM run itself — the handler reads
    // conv IDs from LLM metadata, not from the parent chain's metadata.
    handler.handleLLMStart(
      { name: "ChatAnthropic", id: ["ChatAnthropic"] },
      ["Dispatch tasks."],
      "llm-orch",
      "orch-run",
      undefined,
      undefined,
      { "gen_ai.conversation.id": ORCH_CONV },
    );
    handler.handleLLMEnd(
      {
        generations: [[{ text: "Plan ready." }]],
        llmOutput: { usage: { input_tokens: 15, output_tokens: 5 } },
      },
      "llm-orch",
    );
    handler.handleChainEnd({}, "orch-run");

    // Two researcher chains (phase 2 — parallel, different conversation IDs)
    handler.handleChainStart(
      { name: "researcher", id: ["researcher"] },
      {},
      "primes-run",
      undefined,
      undefined,
      { "gen_ai.conversation.id": PRIMES_CONV },
    );
    handler.handleChainStart(
      { name: "researcher", id: ["researcher"] },
      {},
      "fib-run",
      undefined,
      undefined,
      { "gen_ai.conversation.id": FIB_CONV },
    );
    handler.handleLLMStart(
      { name: "ChatAnthropic", id: ["ChatAnthropic"] },
      ["Explain primes."],
      "llm-primes",
      "primes-run",
      undefined,
      undefined,
      { "gen_ai.conversation.id": PRIMES_CONV },
    );
    handler.handleLLMStart(
      { name: "ChatAnthropic", id: ["ChatAnthropic"] },
      ["Explain Fibonacci."],
      "llm-fib",
      "fib-run",
      undefined,
      undefined,
      { "gen_ai.conversation.id": FIB_CONV },
    );
    handler.handleLLMEnd(
      {
        generations: [[{ text: "Primes are..." }]],
        llmOutput: { usage: { input_tokens: 20, output_tokens: 10 } },
      },
      "llm-primes",
    );
    handler.handleLLMEnd(
      {
        generations: [[{ text: "Fibonacci is..." }]],
        llmOutput: { usage: { input_tokens: 20, output_tokens: 10 } },
      },
      "llm-fib",
    );
    handler.handleChainEnd({}, "primes-run");
    handler.handleChainEnd({}, "fib-run");

    // Orchestrator chain (phase 3 — same conversation as phase 1)
    handler.handleChainStart(
      { name: "orchestrator", id: ["orchestrator"] },
      {},
      "orch-run-2",
      undefined,
      undefined,
      { "gen_ai.conversation.id": ORCH_CONV },
    );
    handler.handleLLMStart(
      { name: "ChatAnthropic", id: ["ChatAnthropic"] },
      ["Synthesise."],
      "llm-orch-2",
      "orch-run-2",
      undefined,
      undefined,
      { "gen_ai.conversation.id": ORCH_CONV },
    );
    handler.handleLLMEnd(
      {
        generations: [[{ text: "In summary..." }]],
        llmOutput: { usage: { input_tokens: 30, output_tokens: 12 } },
      },
      "llm-orch-2",
    );
    handler.handleChainEnd({}, "orch-run-2");

    await handler.forceFlush();
    const spans = exporter.getFinishedSpans();
    const llmSpans = spans.filter(
      (s) => s.attributes["gen_ai.operation.name"] === "chat",
    );

    expect(llmSpans.length).toBe(4);

    const orchLlmSpans = llmSpans.filter(
      (s) => s.attributes["gen_ai.conversation.id"] === ORCH_CONV,
    );
    const primesLlmSpans = llmSpans.filter(
      (s) => s.attributes["gen_ai.conversation.id"] === PRIMES_CONV,
    );
    const fibLlmSpans = llmSpans.filter(
      (s) => s.attributes["gen_ai.conversation.id"] === FIB_CONV,
    );

    // Phase 1 and phase 3 orchestrator spans share the same conversation ID
    expect(orchLlmSpans).toHaveLength(2);
    // Each researcher has its own conversation ID
    expect(primesLlmSpans).toHaveLength(1);
    expect(fibLlmSpans).toHaveLength(1);

    // All orchestrator LLM spans have agent name "orchestrator"
    for (const span of orchLlmSpans) {
      expect(span.attributes["gen_ai.agent.name"]).toBe("orchestrator");
    }
    // Researcher spans have agent name "researcher"
    expect(primesLlmSpans[0].attributes["gen_ai.agent.name"]).toBe(
      "researcher",
    );
    expect(fibLlmSpans[0].attributes["gen_ai.agent.name"]).toBe("researcher");
  });
});

describe("LangChain Subagents — end-to-end with Anthropic API", () => {
  it("propagates runName and conversation ID to LLM spans via real API call", async () => {
    let ChatAnthropic: typeof import("@langchain/anthropic").ChatAnthropic;
    let RunnableLambda: typeof import("@langchain/core/runnables").RunnableLambda;
    let IntrospectionCallbackHandler: typeof import("@introspection-sdk/introspection-node/langchain").IntrospectionCallbackHandler;

    try {
      ({ ChatAnthropic } = await import("@langchain/anthropic"));
      ({ RunnableLambda } = await import("@langchain/core/runnables"));
      ({ IntrospectionCallbackHandler } =
        await import("@introspection-sdk/introspection-node/langchain"));
    } catch {
      console.log(
        "Skipping: required packages not installed (@langchain/anthropic, @langchain/core)",
      );
      return;
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      console.log("Skipping: ANTHROPIC_API_KEY not set");
      return;
    }

    const exporter = new TestSpanExporter();
    const handler = new IntrospectionCallbackHandler({
      advanced: { spanExporter: exporter, useSimpleSpanProcessor: true },
    });

    const model = new ChatAnthropic({ model: "claude-haiku-4-5" });

    const CONV_ID = `lc-subagent-e2e-${Date.now()}`;

    const agentChain = RunnableLambda.from(
      async (
        _input: null,
        config?: import("@langchain/core/runnables").RunnableConfig,
      ) => {
        const response = await model.invoke(
          [{ role: "user", content: "Say hello in one word." }],
          {
            ...config,
            metadata: {
              ...(config?.metadata ?? {}),
              "gen_ai.conversation.id": CONV_ID,
            },
          },
        );
        return response.content;
      },
    ).withConfig({
      runName: "subagent-test",
      metadata: { "gen_ai.conversation.id": CONV_ID },
    });

    await agentChain.invoke(null, {
      callbacks: [handler],
      metadata: { "gen_ai.conversation.id": CONV_ID },
    });

    await handler.forceFlush();
    const spans = exporter.getFinishedSpans();
    const llmSpan = spans.find(
      (s) => s.attributes["gen_ai.operation.name"] === "chat",
    );

    expect(llmSpan).toBeDefined();
    expect(llmSpan?.attributes["gen_ai.conversation.id"]).toBe(CONV_ID);

    await handler.shutdown();
  });
});
