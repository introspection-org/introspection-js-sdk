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

import {
  setupTracing,
  registerOTelGlobals,
} from "../../packages/introspection-node/src/otel/setup";
import {
  init,
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

describe("registerOTelGlobals conflict behaviour", () => {
  afterEach(() => resetOTelGlobals());

  it("throws when a manager/propagator is already registered and onConflict='throw'", () => {
    registerOTelGlobals("replace"); // establish a registration
    expect(() => registerOTelGlobals("throw")).toThrow(/already registered/i);
  });

  it("force-replaces an existing registration with onConflict='replace'", () => {
    registerOTelGlobals();
    expect(() => registerOTelGlobals("replace")).not.toThrow();
  });

  it("warns and continues with onConflict='warn' (default)", () => {
    registerOTelGlobals();
    // Second call: OTel refuses re-registration; warn path swallows it.
    expect(() => registerOTelGlobals("warn")).not.toThrow();
  });
});

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

  it("stops returning a provider the caller has shut down", async () => {
    // The module caches the provider it built. Without invalidation, a
    // setupTracing() after shutdown() hands back the dead one and every
    // subsequent span is dropped in silence.
    const first = setupTracing({
      token: "test-token",
      onConflict: "replace",
      advanced: { spanExporter: new InMemorySpanExporter() },
    });
    expect(setupTracing({ token: "test-token", onConflict: "replace" })).toBe(
      first,
    );

    await first.shutdown();

    const vendor = new InMemorySpanExporter();
    const second = setupTracing({
      token: "test-token",
      onConflict: "replace",
      advanced: { spanExporter: new InMemorySpanExporter() },
      additionalSpanProcessors: [new SimpleSpanProcessor(vendor)],
    });
    expect(second).not.toBe(first);

    second.getTracer("test").startSpan("after-shutdown").end();
    await second.forceFlush();
    expect(vendor.getFinishedSpans().map((s) => s.name)).toContain(
      "after-shutdown",
    );

    await second.shutdown();
  });
});

describe("init({ tracerProvider }) provider ownership", () => {
  afterEach(async () => {
    await shutdown();
    _resetForTests();
    resetOTelGlobals();
  });

  it("leaves a caller-supplied provider running so its processors keep exporting", async () => {
    // The dual-export example got this wrong: it called only
    // `introspection.shutdown()` and printed a success line, while the
    // second backend's batch processor was never flushed.
    const { NodeTracerProvider } =
      await import("@opentelemetry/sdk-trace-node");
    const { IntrospectionSpanProcessor } =
      await import("../../packages/introspection-node/src/otel/span-processor");

    registerOTelGlobals("replace");
    const vendor = new InMemorySpanExporter();
    const provider = new NodeTracerProvider({
      spanProcessors: [
        new IntrospectionSpanProcessor({
          advanced: { spanExporter: new InMemorySpanExporter() },
        }),
        new SimpleSpanProcessor(vendor),
      ],
    });

    await init({ tracerProvider: provider, autoDiscover: false, token: "t" });
    await shutdown();

    // Still live: the caller owns it, so the span lands.
    provider.getTracer("test").startSpan("after-sdk-shutdown").end();
    await provider.forceFlush();
    expect(vendor.getFinishedSpans().map((s) => s.name)).toContain(
      "after-sdk-shutdown",
    );

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
