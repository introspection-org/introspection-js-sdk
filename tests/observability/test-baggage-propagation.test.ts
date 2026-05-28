import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { context, propagation, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";

import {
  IntrospectionLogs,
  IntrospectionSpanProcessor,
} from "@introspection-sdk/introspection-node/otel";
import { TestSpanExporter, IncrementalIdGenerator } from "../testing";

/**
 * Baggage propagation through IntrospectionSpanProcessor.
 *
 * Covers the foundation that the framework-specific baggage tests build on:
 *   1. context.with() is a no-op without AsyncLocalStorageContextManager —
 *      baggage would never reach span-creation sites.
 *   2. IntrospectionSpanProcessor merges baggage into span attributes at
 *      onEnd, so any framework whose instrumentor uses the global tracer
 *      benefits automatically.
 *
 * Tests here intentionally don't go through any LLM SDK — they isolate the
 * processor-side baggage merge using plain tracer.startSpan() calls.
 * Framework-specific baggage paths (LangChain, Vercel AI SDK, Pi, Claude
 * Agent SDK) live in their dedicated test files and use real SDK calls
 * against recordings.
 */

describe("baggage propagation — IntrospectionSpanProcessor", () => {
  beforeEach(() => {
    context.setGlobalContextManager(
      new AsyncLocalStorageContextManager().enable(),
    );
  });

  afterEach(() => {
    context.disable();
    trace.disable();
    propagation.disable();
  });

  it("withAgent / withConversation set baggage that the span processor merges into span attrs", async () => {
    const exporter = new TestSpanExporter();
    const provider = new BasicTracerProvider({
      idGenerator: new IncrementalIdGenerator(),
      spanProcessors: [
        new IntrospectionSpanProcessor({
          token: "test-token",
          advanced: { spanExporter: exporter },
        }),
      ],
    });
    trace.setGlobalTracerProvider(provider);

    const introspect = new IntrospectionLogs({ token: "test-token" });
    const tracer = trace.getTracer("test");

    await introspect.withAgent("researcher", "researcher-primes", () =>
      introspect.withConversation("conv-primes", undefined, async () => {
        const span = tracer.startSpan("chat", {
          attributes: {
            "gen_ai.system": "anthropic",
            "gen_ai.operation.name": "chat",
            "gen_ai.request.model": "claude-sonnet-4-6",
          },
        });
        span.end();
      }),
    );

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);
    expect(spans[0].attributes["gen_ai.agent.name"]).toBe("researcher");
    expect(spans[0].attributes["gen_ai.agent.id"]).toBe("researcher-primes");
    expect(spans[0].attributes["gen_ai.conversation.id"]).toBe("conv-primes");

    await provider.shutdown();
  });

  it("parallel agents inside Promise.all get distinct baggage in each branch", async () => {
    const exporter = new TestSpanExporter();
    const provider = new BasicTracerProvider({
      idGenerator: new IncrementalIdGenerator(),
      spanProcessors: [
        new IntrospectionSpanProcessor({
          token: "test-token",
          advanced: { spanExporter: exporter },
        }),
      ],
    });
    trace.setGlobalTracerProvider(provider);

    const introspect = new IntrospectionLogs({ token: "test-token" });
    const tracer = trace.getTracer("test");

    async function run(agentId: string, convId: string) {
      await introspect.withAgent("researcher", agentId, () =>
        introspect.withConversation(convId, undefined, async () => {
          // Yield to let the other branch interleave — proves AsyncLocalStorage
          // forks baggage per branch rather than depending on call ordering.
          await new Promise((r) => setImmediate(r));
          tracer
            .startSpan("chat", { attributes: { "gen_ai.system": "anthropic" } })
            .end();
        }),
      );
    }

    await Promise.all([
      run("researcher-primes", "conv-primes"),
      run("researcher-fib", "conv-fib"),
    ]);

    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(2);

    const primes = spans.find(
      (s) => s.attributes["gen_ai.agent.id"] === "researcher-primes",
    );
    const fib = spans.find(
      (s) => s.attributes["gen_ai.agent.id"] === "researcher-fib",
    );
    expect(primes?.attributes["gen_ai.conversation.id"]).toBe("conv-primes");
    expect(primes?.attributes["gen_ai.agent.id"]).toBe("researcher-primes");
    expect(fib?.attributes["gen_ai.conversation.id"]).toBe("conv-fib");
    expect(fib?.attributes["gen_ai.agent.id"]).toBe("researcher-fib");

    await provider.shutdown();
  });
});
