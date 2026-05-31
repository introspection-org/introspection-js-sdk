/**
 * Coverage for the low-level dual-export hook
 * (`setupTracing({ additionalSpanProcessors })`) and the zero-code preload
 * (`otel/register`). No mocks: a real {@link InMemorySpanExporter} stands in for
 * the downstream vendor processor, and the preload drives the real `init()`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { trace, context, propagation } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import { setupTracing } from "../../packages/introspection-node/src/otel/setup";
import {
  getTracerProvider,
  getClient,
  shutdown,
  _resetForTests,
} from "../../packages/introspection-node/src/otel/init";

function resetOTelGlobals() {
  context.disable();
  propagation.disable();
  trace.disable();
}

describe("setupTracing({ additionalSpanProcessors })", () => {
  afterEach(async () => {
    resetOTelGlobals();
  });

  it("fans every span out to the extra processor after the Introspection one", async () => {
    const vendor = new InMemorySpanExporter();
    const provider = setupTracing({
      token: "test-token",
      serviceName: "dual-export-test",
      onConflict: "replace",
      // Keep the Introspection processor offline (no OTLP) via a real
      // in-memory exporter; the vendor processor is what we assert on.
      advanced: { spanExporter: new InMemorySpanExporter() },
      additionalSpanProcessors: [new SimpleSpanProcessor(vendor)],
    });

    const tracer = provider.getTracer("test");
    tracer.startSpan("unit-of-work").end();

    await provider.forceFlush();
    const spans = vendor.getFinishedSpans();
    expect(spans.map((s) => s.name)).toContain("unit-of-work");

    await provider.shutdown();
  });
});

describe("otel/register preload", () => {
  afterEach(async () => {
    await shutdown();
    _resetForTests();
    resetOTelGlobals();
    delete process.env.INTROSPECTION_TOKEN;
  });

  it("is a no-op (and does not init) when no token is configured", async () => {
    delete process.env.INTROSPECTION_TOKEN;
    const { registerFromEnv } =
      await import("../../packages/introspection-node/src/otel/register");
    await registerFromEnv();
    // init() was never called, so the provider accessor must throw.
    expect(() => getTracerProvider()).toThrow(/init/);
  });

  it("runs init() from the environment when a token is present", async () => {
    process.env.INTROSPECTION_TOKEN = "preload-token";
    const { registerFromEnv } =
      await import("../../packages/introspection-node/src/otel/register");
    await registerFromEnv();
    expect(getTracerProvider()).toBeDefined();
    // The analytics surface is wired too (IntrospectionLogs).
    expect(getClient()).toBeDefined();
  });
});
