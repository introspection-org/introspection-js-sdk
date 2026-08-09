/**
 * What the two OTLP exporters put in their request headers.
 *
 * Both streams have to identify the SDK and its release, the way the Python
 * on both exporters. The logs exporter got a `User-Agent`
 * and the traces exporter three files over did not, so exported spans
 * arrived at the collector unattributable to a client or a version. The
 * header set is built by one shared helper now; these assert that each
 * exporter is actually constructed with it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const traceExporterArgs: unknown[] = [];
const logExporterArgs: unknown[] = [];

vi.mock("@opentelemetry/exporter-trace-otlp-proto", () => ({
  OTLPTraceExporter: class {
    constructor(config: unknown) {
      traceExporterArgs.push(config);
    }
    export() {}
    shutdown() {
      return Promise.resolve();
    }
    forceFlush() {
      return Promise.resolve();
    }
  },
}));

vi.mock("@opentelemetry/exporter-logs-otlp-proto", () => ({
  OTLPLogExporter: class {
    constructor(config: unknown) {
      logExporterArgs.push(config);
    }
    export() {}
    shutdown() {
      return Promise.resolve();
    }
    forceFlush() {
      return Promise.resolve();
    }
  },
}));

const { IntrospectionSpanProcessor } =
  await import("../../packages/introspection-node/src/otel/span-processor.js");
const { IntrospectionLogs } =
  await import("../../packages/introspection-node/src/otel/logs.js");

function headersOf(args: unknown[]): Record<string, string> {
  const last = args.at(-1) as { headers?: Record<string, string> };
  return last?.headers ?? {};
}

beforeEach(() => {
  traceExporterArgs.length = 0;
  logExporterArgs.length = 0;
});

describe("both OTLP exporters identify the SDK", () => {
  it("the traces exporter sends a User-Agent and the token", () => {
    new IntrospectionSpanProcessor({ token: "intro_test" });
    const headers = headersOf(traceExporterArgs);
    expect(headers["User-Agent"]).toMatch(/^introspection-sdk\/\d+\.\d+\.\d+/);
    expect(headers["Authorization"]).toBe("Bearer intro_test");
  });

  it("the logs exporter sends the same pair", () => {
    new IntrospectionLogs({ token: "intro_test" });
    const headers = headersOf(logExporterArgs);
    expect(headers["User-Agent"]).toMatch(/^introspection-sdk\/\d+\.\d+\.\d+/);
    expect(headers["Authorization"]).toBe("Bearer intro_test");
  });

  it("agree on the User-Agent they send", () => {
    new IntrospectionSpanProcessor({ token: "intro_test" });
    new IntrospectionLogs({ token: "intro_test" });
    expect(headersOf(traceExporterArgs)["User-Agent"]).toBe(
      headersOf(logExporterArgs)["User-Agent"],
    );
  });

  it("let the caller override either header on the traces stream", () => {
    new IntrospectionSpanProcessor({
      token: "intro_test",
      advanced: { additionalHeaders: { "User-Agent": "my-app/1.0" } },
    });
    expect(headersOf(traceExporterArgs)["User-Agent"]).toBe("my-app/1.0");
  });
});
