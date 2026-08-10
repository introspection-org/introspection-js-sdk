/**
 * The `AdvancedOptions` knobs that were accepted and then dropped.
 *
 * Three separate cases of the same shape — the type promises a knob and
 * nothing downstream consumes it:
 *
 *  - `logExporter` was forwarded by nothing in `init()`, so
 *    `init({ advanced: { logExporter } })` built an OTLP exporter anyway and
 *    every analytics event went to the real collector. That is the one option
 *    documented as the seam for asserting what goes out on the wire.
 *  - `debug` was read only by the browser client; in Node the flag did
 *    nothing and `INTROSPECTION_LOG_LEVEL` was the only way in.
 *  - `maxQueueSize` did not exist at all. It bounds the queue rather than one
 *    export, so under a burst larger than the OTel default the processor
 *    drops spans silently with no knob to raise the ceiling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  init,
  _resetForTests,
  track,
  IntrospectionLogs,
  IntrospectionSpanProcessor,
  resetInstalledForTests,
} from "@introspection-sdk/introspection-node/otel";
import { installTestOTelGlobals } from "../polly-setup";

describe("AdvancedOptions wiring", () => {
  let dispose: () => void;

  beforeEach(() => {
    dispose = installTestOTelGlobals();
    _resetForTests();
    resetInstalledForTests();
  });

  afterEach(() => {
    dispose();
    vi.restoreAllMocks();
  });

  it("init() routes analytics through advanced.logExporter", async () => {
    const logExporter = new InMemoryLogRecordExporter();
    await init({
      token: "t",
      autoDiscover: false,
      advanced: {
        spanExporter: new InMemorySpanExporter(),
        logExporter,
        // Export on every record so the assertion does not race the batcher.
        maxBatchSize: 1,
        flushInterval: 1,
      },
    });

    track("Button Clicked", { button_id: "submit" });
    await new Promise((r) => setTimeout(r, 50));

    const records = logExporter.getFinishedLogRecords();
    expect(records.length).toBeGreaterThan(0);
    expect(records[0]!.attributes["event.name"]).toBe("Button Clicked");
    expect(records[0]!.attributes["properties.button_id"]).toBe("submit");
  });

  it("passes maxQueueSize through to the span batch processor", () => {
    const processor = new IntrospectionSpanProcessor({
      token: "t",
      advanced: {
        spanExporter: new InMemorySpanExporter(),
        maxQueueSize: 64,
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const batch = (processor as any)._spanProcessor;
    expect(batch._maxQueueSize).toBe(64);
  });

  it("leaves the OTel default queue bound when maxQueueSize is unset", () => {
    const processor = new IntrospectionSpanProcessor({
      token: "t",
      advanced: { spanExporter: new InMemorySpanExporter() },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const batch = (processor as any)._spanProcessor;
    expect(batch._maxQueueSize).toBe(2048);
  });

  it("passes maxQueueSize through to the logs batch processor", () => {
    const logs = new IntrospectionLogs({
      token: "t",
      logExporter: new InMemoryLogRecordExporter(),
      maxQueueSize: 64,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const processor = (logs as any).loggerProvider._sharedState
      .registeredLogRecordProcessors[0];
    expect(processor._maxQueueSize).toBe(64);
  });
});

/**
 * `advanced.debug` raises the level on a module-singleton logger, so each of
 * these needs its own module graph — otherwise the first test that enables
 * debug decides the outcome of the one asserting it stays off.
 */
describe("AdvancedOptions.debug", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.INTROSPECTION_LOG_LEVEL;
  });

  afterEach(() => vi.restoreAllMocks());

  async function freshOtel() {
    const otel =
      await import("../../packages/introspection-node/src/otel/index.js");
    const { logger } =
      await import("../../packages/introspection-node/src/utils.js");
    return { ...otel, logger };
  }

  it("is honoured by the span processor", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const { IntrospectionSpanProcessor, logger } = await freshOtel();
    new IntrospectionSpanProcessor({
      token: "t",
      advanced: { spanExporter: new InMemorySpanExporter(), debug: true },
    });
    logger.debug("marker");
    expect(
      debugSpy.mock.calls.some((call) => String(call[1] ?? "") === "marker"),
    ).toBe(true);
  });

  it("is honoured by init() even when it builds no processor", async () => {
    // Distinct from the case above: with a caller-supplied `tracerProvider`,
    // `resolveProvider` returns early and no IntrospectionSpanProcessor is
    // constructed, so init() is the only place left that can read the flag.
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const { init, logger } = await freshOtel();
    const { NodeTracerProvider } =
      await import("@opentelemetry/sdk-trace-node");
    const own = new NodeTracerProvider();
    await init({
      token: "t",
      autoDiscover: false,
      tracerProvider: own,
      advanced: { debug: true },
    });
    logger.debug("marker");
    expect(
      debugSpy.mock.calls.some((call) => String(call[1] ?? "") === "marker"),
    ).toBe(true);
    await own.shutdown();
  });

  it("leaves the quiet default alone when absent", async () => {
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const { IntrospectionSpanProcessor, logger } = await freshOtel();
    new IntrospectionSpanProcessor({
      token: "t",
      advanced: { spanExporter: new InMemorySpanExporter() },
    });
    logger.debug("marker");
    expect(
      debugSpy.mock.calls.some((call) => String(call[1] ?? "") === "marker"),
    ).toBe(false);
  });
});
