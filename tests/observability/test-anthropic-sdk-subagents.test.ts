/**
 * Tests for the Anthropic SDK multi-agent subagent pattern via baggage.
 *
 * Covers the combination of AnthropicInstrumentor + IntrospectionLogs
 * .withAgent()/.withConversation() used in
 * examples/otel/anthropic-sdk/subagents-baggage.ts:
 *   - withAgent(name, id, fn) sets gen_ai.agent.name / gen_ai.agent.id baggage
 *   - withConversation(id, _, fn) sets gen_ai.conversation.id baggage
 *   - AnthropicInstrumentor reads baggage from OTel context and stamps it
 *     on each span produced by the instrumented Anthropic client
 *   - Parallel agents in Promise.all preserve per-branch baggage via
 *     AsyncLocalStorage
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  IntrospectionLogs,
  AnthropicInstrumentor,
  IntrospectionSpanProcessor,
} from "@introspection-sdk/introspection-node/otel";
import {
  TestSpanExporter,
  IncrementalIdGenerator,
  simplifySpansForSnapshot,
} from "../testing";
import { setupPolly, ensureEnvVarsForReplay } from "../polly-setup";
import type Polly from "@pollyjs/core";

describe("Anthropic SDK Subagents — AnthropicInstrumentor + baggage propagation", () => {
  let exporter: TestSpanExporter | null = null;
  let provider: NodeTracerProvider | null = null;
  let instrumentor: AnthropicInstrumentor | null = null;
  let polly: Polly | null = null;

  beforeEach(() => {
    polly = setupPolly({
      recordingName: "anthropic-sdk-subagents",
    });

    if (
      !ensureEnvVarsForReplay(["ANTHROPIC_API_KEY"], "anthropic-sdk-subagents")
    ) {
      console.log(
        "Skipping: Required env vars not set for record/passthrough mode",
      );
      polly.stop();
      polly = null;
      return;
    }

    // AsyncLocalStorageContextManager is required for context.with() to actually
    // propagate baggage across async boundaries — without it, withAgent() /
    // withConversation() silently drop the context.
    context.setGlobalContextManager(
      new AsyncLocalStorageContextManager().enable(),
    );

    exporter = new TestSpanExporter();
    provider = new NodeTracerProvider({
      idGenerator: new IncrementalIdGenerator(),
      spanProcessors: [
        new IntrospectionSpanProcessor({
          token: "test-token",
          advanced: { spanExporter: exporter, useSimpleSpanProcessor: true },
        }),
      ],
    });
    provider.register();

    instrumentor = new AnthropicInstrumentor();
  });

  afterEach(async () => {
    if (instrumentor) {
      instrumentor.uninstrument();
      instrumentor = null;
    }
    if (provider) {
      await provider.forceFlush();
      await provider.shutdown();
      provider = null;
    }
    context.disable();
    trace.disable();
    propagation.disable();
    exporter = null;
    if (polly) {
      await polly.stop();
      polly = null;
    }
  });

  it("stamps agent name, agent ID, and conversation ID from baggage onto Anthropic spans", async () => {
    if (!exporter || !provider || !instrumentor) return;

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic();
    instrumentor.instrument({ tracerProvider: provider, client });

    const introspect = new IntrospectionLogs({ token: "test-token" });

    const ORCH_CONV = "anthropic-orch-conv-test";

    await introspect.withAgent("orchestrator", "orchestrator-main", () =>
      introspect.withConversation(ORCH_CONV, undefined, () =>
        client.messages.create({
          model: "claude-haiku-4-5",
          max_tokens: 16,
          messages: [{ role: "user", content: "Explain primes in 5 words." }],
        }),
      ),
    );

    await provider.forceFlush();
    const spans = simplifySpansForSnapshot(exporter.getFinishedSpans());

    expect(spans.length).toBeGreaterThan(0);

    const chatSpan = spans.find(
      (s) => s.attributes["gen_ai.operation.name"] === "chat",
    );
    expect(chatSpan).toBeDefined();
    expect(chatSpan?.attributes["gen_ai.agent.name"]).toBe("orchestrator");
    expect(chatSpan?.attributes["gen_ai.agent.id"]).toBe("orchestrator-main");
    expect(chatSpan?.attributes["gen_ai.conversation.id"]).toBe(ORCH_CONV);
  });

  it("parallel agents in Promise.all get distinct baggage per async branch", async () => {
    if (!exporter || !provider || !instrumentor) return;

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const client = new Anthropic();
    instrumentor.instrument({ tracerProvider: provider, client });

    const introspect = new IntrospectionLogs({ token: "test-token" });

    const PRIMES_CONV = "anthropic-primes-conv-test";
    const FIB_CONV = "anthropic-fib-conv-test";

    // Promise.all forks the async context — each branch keeps its own baggage
    await Promise.all([
      introspect.withAgent("researcher", "researcher-primes", () =>
        introspect.withConversation(PRIMES_CONV, undefined, () =>
          client.messages.create({
            model: "claude-haiku-4-5",
            max_tokens: 16,
            messages: [{ role: "user", content: "Explain primes in 5 words." }],
          }),
        ),
      ),
      introspect.withAgent("researcher", "researcher-fib", () =>
        introspect.withConversation(FIB_CONV, undefined, () =>
          client.messages.create({
            model: "claude-haiku-4-5",
            max_tokens: 16,
            messages: [
              {
                role: "user",
                content: "Explain Fibonacci in 5 words.",
              },
            ],
          }),
        ),
      ),
    ]);

    await provider.forceFlush();
    const spans = simplifySpansForSnapshot(exporter.getFinishedSpans());

    const chatSpans = spans.filter(
      (s) => s.attributes["gen_ai.operation.name"] === "chat",
    );
    expect(chatSpans.length).toBe(2);

    const primesSpan = chatSpans.find(
      (s) => s.attributes["gen_ai.conversation.id"] === PRIMES_CONV,
    );
    const fibSpan = chatSpans.find(
      (s) => s.attributes["gen_ai.conversation.id"] === FIB_CONV,
    );

    expect(primesSpan).toBeDefined();
    expect(fibSpan).toBeDefined();

    // Each branch preserved its own agent ID despite running in parallel
    expect(primesSpan?.attributes["gen_ai.agent.id"]).toBe("researcher-primes");
    expect(fibSpan?.attributes["gen_ai.agent.id"]).toBe("researcher-fib");

    // Baggage did not bleed between branches
    expect(primesSpan?.attributes["gen_ai.conversation.id"]).not.toBe(FIB_CONV);
    expect(fibSpan?.attributes["gen_ai.conversation.id"]).not.toBe(PRIMES_CONV);
  });
});
