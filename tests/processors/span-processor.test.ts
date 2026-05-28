import { context, trace, SpanKind } from "@opentelemetry/api";
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
});
