import { context, propagation, trace, SpanKind } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";

import { IntrospectionSpanProcessor } from "../../packages/introspection-node/src/otel/span-processor";
import { IncrementalIdGenerator } from "../testing";

describe("IntrospectionSpanProcessor", () => {
  it("preserves parent span context when converting OpenInference spans", async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      idGenerator: new IncrementalIdGenerator(),
      spanProcessors: [
        new IntrospectionSpanProcessor({
          token: "test-token",
          advanced: { spanExporter: exporter },
        }),
      ],
    });
    const tracer = provider.getTracer("openinference.instrumentation.test");

    const parent = tracer.startSpan("agent", {
      kind: SpanKind.INTERNAL,
      attributes: {
        "openinference.span.kind": "CHAIN",
      },
    });
    const child = tracer.startSpan(
      "chat",
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "openinference.span.kind": "LLM",
          "llm.model_name": "gpt-test",
          "llm.input_messages.0.message.role": "user",
          "llm.input_messages.0.message.content": "hi",
        },
      },
      trace.setSpan(context.active(), parent),
    );

    child.end();
    parent.end();
    await provider.forceFlush();

    const spans = exporter.getFinishedSpans();
    const exportedChild = spans.find((span) => span.name === "chat");
    const exportedParent = spans.find((span) => span.name === "agent");

    expect(exportedParent).toBeDefined();
    expect(exportedChild).toBeDefined();
    expect(exportedChild?.parentSpanContext?.spanId).toBe(
      exportedParent?.spanContext().spanId,
    );
    expect(exportedChild?.spanContext().traceId).toBe(
      exportedParent?.spanContext().traceId,
    );

    await provider.shutdown();
  });

  it("projects end-user identity baggage onto span attributes", async () => {
    // The processor reads baggage from the active context at span end, so the
    // test needs a real context manager (production registers AsyncHooks).
    const contextManager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(contextManager);
    try {
      const exporter = new InMemorySpanExporter();
      const provider = new BasicTracerProvider({
        idGenerator: new IncrementalIdGenerator(),
        spanProcessors: [
          new IntrospectionSpanProcessor({
            token: "test-token",
            advanced: { spanExporter: exporter },
          }),
        ],
      });
      const tracer = provider.getTracer("test");

      // Identity set once on the run-root context as baggage; the processor
      // projects it onto every span that ends within that context.
      const baggage = propagation.createBaggage({
        "identity.user_id": { value: "u_42" },
        "identity.anonymous_id": { value: "anon_9" },
      });
      const ctx = propagation.setBaggage(context.active(), baggage);

      await context.with(ctx, async () => {
        const span = tracer.startSpan("chat", {
          kind: SpanKind.INTERNAL,
          attributes: { "gen_ai.input.messages": "[]" },
        });
        span.end();
      });
      await provider.forceFlush();

      const span = exporter.getFinishedSpans().find((s) => s.name === "chat");
      expect(span?.attributes["identity.user.id"]).toBe("u_42");
      expect(span?.attributes["identity.anonymous.id"]).toBe("anon_9");

      await provider.shutdown();
    } finally {
      context.disable();
    }
  });
});
