import { createServer, type IncomingMessage, type Server } from "node:http";
import { AddressInfo } from "node:net";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { createIntrospectionExporter } from "../../packages/introspection-node/src/otel/exporter";

interface CapturedRequest {
  url: string;
  headers: IncomingMessage["headers"];
}

/**
 * Exercises the standalone exporter end-to-end against a local OTLP-ish HTTP
 * server (precedent: tests/api/reconnect-live.test.ts) so the assertions
 * cover the exporter's real request URL and headers rather than internal
 * OTLPTraceExporter config shape.
 */
describe("createIntrospectionExporter", () => {
  const captured: CapturedRequest[] = [];
  let server: Server;
  let baseUrl: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    server = createServer((req, res) => {
      captured.push({ url: req.url ?? "", headers: req.headers });
      res.writeHead(200, { "content-type": "application/x-protobuf" });
      res.end();
    });
    await new Promise<void>((resolveListen) => {
      server.listen(0, "127.0.0.1", resolveListen);
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;

    for (const key of ["INTROSPECTION_TOKEN", "INTROSPECTION_BASE_OTEL_URL"]) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  afterEach(() => {
    captured.length = 0;
    delete process.env.INTROSPECTION_TOKEN;
    delete process.env.INTROSPECTION_BASE_OTEL_URL;
  });

  async function exportOneSpan(exporter: SpanExporter): Promise<void> {
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    provider.getTracer("exporter-test").startSpan("chat").end();
    await provider.forceFlush();
    await provider.shutdown();
  }

  it("throws when no token is provided and INTROSPECTION_TOKEN is unset", () => {
    expect(() => createIntrospectionExporter()).toThrow(
      "createIntrospectionExporter: token is required (pass token or set INTROSPECTION_TOKEN)",
    );
  });

  it("appends /v1/traces to the base URL and sends bearer auth", async () => {
    const exporter = createIntrospectionExporter({
      token: "test-token",
      baseUrl: `${baseUrl}/collector`,
      headers: { "x-extra": "extra-value" },
    });
    await exportOneSpan(exporter);

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("/collector/v1/traces");
    expect(captured[0].headers.authorization).toBe("Bearer test-token");
    expect(captured[0].headers["x-extra"]).toBe("extra-value");
  });

  it("strips a trailing slash before appending /v1/traces", async () => {
    const exporter = createIntrospectionExporter({
      token: "test-token",
      baseUrl: `${baseUrl}/collector/`,
    });
    await exportOneSpan(exporter);

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("/collector/v1/traces");
  });

  it("uses a base URL that already ends in /v1/traces as-is", async () => {
    const exporter = createIntrospectionExporter({
      token: "test-token",
      baseUrl: `${baseUrl}/custom/v1/traces`,
    });
    await exportOneSpan(exporter);

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("/custom/v1/traces");
  });

  it("falls back to INTROSPECTION_TOKEN and INTROSPECTION_BASE_OTEL_URL", async () => {
    process.env.INTROSPECTION_TOKEN = "env-token";
    process.env.INTROSPECTION_BASE_OTEL_URL = baseUrl;

    const exporter = createIntrospectionExporter();
    await exportOneSpan(exporter);

    expect(captured).toHaveLength(1);
    expect(captured[0].url).toBe("/v1/traces");
    expect(captured[0].headers.authorization).toBe("Bearer env-token");
  });
});
