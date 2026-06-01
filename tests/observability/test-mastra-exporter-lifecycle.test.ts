/**
 * Lifecycle/branch coverage for IntrospectionMastraExporter — construction,
 * init() provider wiring (test-mode and token-mode), flush, shutdown, and the
 * early-return guards. No mocks: a real InMemorySpanExporter stands in for the
 * downstream exporter; span conversion itself is covered by the Polly-backed
 * test-mastra-exporter.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import { IntrospectionMastraExporter } from "../../packages/introspection-node/src/otel/mastra-exporter";
import { IncrementalIdGenerator } from "../testing";

// init() accepts Mastra's InitExporterOptions; we only use `config.serviceName`.
const initWith = (serviceName: string) =>
  ({ config: { serviceName } }) as never;

describe("IntrospectionMastraExporter lifecycle", () => {
  let prevToken: string | undefined;
  beforeEach(() => {
    prevToken = process.env.INTROSPECTION_TOKEN;
  });
  afterEach(() => {
    if (prevToken === undefined) delete process.env.INTROSPECTION_TOKEN;
    else process.env.INTROSPECTION_TOKEN = prevToken;
  });

  it("disables itself when neither a token nor a custom exporter is provided", async () => {
    delete process.env.INTROSPECTION_TOKEN;
    const exporter = new IntrospectionMastraExporter();
    // Disabled exporters still satisfy the lifecycle contract without throwing.
    exporter.init(initWith("svc"));
    await expect(exporter.flush()).resolves.toBeUndefined();
    await expect(exporter.shutdown()).resolves.toBeUndefined();
  });

  it("wires a test-mode provider from a custom span exporter (batch + simple)", async () => {
    for (const useSimpleSpanProcessor of [false, true]) {
      const exporter = new IntrospectionMastraExporter({
        advanced: {
          spanExporter: new InMemorySpanExporter(),
          idGenerator: new IncrementalIdGenerator(),
          useSimpleSpanProcessor,
        },
      });
      exporter.init(initWith("svc"));
      // Second init() is a no-op (provider already created).
      exporter.init(initWith("svc"));
      await expect(exporter.flush()).resolves.toBeUndefined();
      await expect(exporter.shutdown()).resolves.toBeUndefined();
    }
  });

  it("builds the OTLP provider from a token (dev token → simple processor)", async () => {
    const exporter = new IntrospectionMastraExporter({
      token: "intro_dev_token",
      baseUrl: "https://otel.example.com",
      additionalHeaders: { "x-test": "1" },
    });
    exporter.init(initWith("svc"));
    await expect(exporter.flush()).resolves.toBeUndefined();
    await expect(exporter.shutdown()).resolves.toBeUndefined();
  });

  it("normalises a baseUrl that already ends in /v1/traces", async () => {
    const exporter = new IntrospectionMastraExporter({
      token: "intro_prod_token",
      baseUrl: "https://otel.example.com/v1/traces",
    });
    exporter.init(initWith("svc"));
    await expect(exporter.shutdown()).resolves.toBeUndefined();
  });

  it("ignores non-span_ended tracing events", async () => {
    const exporter = new IntrospectionMastraExporter({
      advanced: { spanExporter: new InMemorySpanExporter() },
    });
    exporter.init(initWith("svc"));
    // _exportTracingEvent is protected; a non-"span_ended" event returns early.
    const exportEvent = (
      exporter as unknown as {
        _exportTracingEvent: (e: unknown) => Promise<void>;
      }
    )._exportTracingEvent.bind(exporter);
    await expect(
      exportEvent({ type: "span_started" }),
    ).resolves.toBeUndefined();
    await exporter.shutdown();
  });
});
