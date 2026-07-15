import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  context,
  propagation,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";

import {
  createProxyFetch,
  installProxyFetch,
  PROXY_CALL_SPAN_NAME,
} from "../../packages/introspection-proxy/src/index";

const ORIGINAL_ENV = {
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  http_proxy: process.env.http_proxy,
  https_proxy: process.env.https_proxy,
  NO_PROXY: process.env.NO_PROXY,
  no_proxy: process.env.no_proxy,
  INTROSPECTION_EGRESS_URL: process.env.INTROSPECTION_EGRESS_URL,
  INTROSPECTION_ENDPOINT_HOSTS: process.env.INTROSPECTION_ENDPOINT_HOSTS,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

describe("installProxyFetch", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("falls back to the original fetch when egress has no configured hosts", async () => {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    process.env.INTROSPECTION_EGRESS_URL = "http://127.0.0.1:65535";
    process.env.INTROSPECTION_ENDPOINT_HOSTS = "";

    const originalFetch = globalThis.fetch;
    const restoreFirst = installProxyFetch();
    const restoreSecond = installProxyFetch();

    try {
      expect(globalThis.fetch).not.toBe(originalFetch);

      const response = await fetch("data:text/plain,ok");

      expect(await response.text()).toBe("ok");
    } finally {
      restoreSecond();
      restoreFirst();
    }

    expect(globalThis.fetch).toBe(originalFetch);
  });
});

describe("introspection-proxy-call spans", () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  propagation.setGlobalPropagator(
    new CompositePropagator({
      propagators: [
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
      ],
    }),
  );

  let server: Server | undefined;

  afterEach(async () => {
    restoreEnv();
    exporter.reset();
    if (server) {
      await new Promise((resolve) => server?.close(resolve));
      server = undefined;
    }
  });

  /** Local HTTP server standing in for the egress / forward proxy hop. */
  async function listen(status = 200): Promise<number> {
    server = createServer((_req, res) => {
      res.statusCode = status;
      res.end("ok");
    });
    await new Promise<void>((resolve) => server?.listen(0, resolve));
    return (server.address() as AddressInfo).port;
  }

  function clearProxyEnv(): void {
    for (const key of Object.keys(ORIGINAL_ENV)) delete process.env[key];
  }

  it("emits an egress-mode span with query-stripped URL and status", async () => {
    clearProxyEnv();
    const port = await listen(200);
    process.env.INTROSPECTION_EGRESS_URL = `http://127.0.0.1:${port}`;
    process.env.INTROSPECTION_ENDPOINT_HOSTS = "endpoint.example.test";

    const proxyFetch = createProxyFetch();
    const response = await proxyFetch(
      "http://endpoint.example.test/v1/things?secret=capability",
      { method: "POST", body: "{}" },
    );
    expect(response.status).toBe(200);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span.name).toBe(PROXY_CALL_SPAN_NAME);
    expect(span.attributes["introspection.proxy.mode"]).toBe("egress");
    expect(span.attributes["http.request.method"]).toBe("POST");
    expect(span.attributes["server.address"]).toBe("endpoint.example.test");
    expect(span.attributes["http.response.status_code"]).toBe(200);
    expect(span.attributes["url.full"]).toBe(
      "http://endpoint.example.test/v1/things",
    );
    expect(String(span.attributes["url.full"])).not.toContain("secret");
  });

  it("keeps the egress connection open between model calls", async () => {
    clearProxyEnv();
    let connections = 0;
    server = createServer((_req, res) => {
      res.setHeader("Connection", "keep-alive");
      res.end("ok");
    });
    server.on("connection", () => {
      connections += 1;
    });
    await new Promise<void>((resolve) => server?.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    process.env.INTROSPECTION_EGRESS_URL = `http://127.0.0.1:${port}`;
    process.env.INTROSPECTION_ENDPOINT_HOSTS = "endpoint.example.test";

    const proxyFetch = createProxyFetch({ tracing: false });
    await (await proxyFetch("http://endpoint.example.test/first")).text();
    await new Promise((resolve) => setTimeout(resolve, 4_100));
    await (await proxyFetch("http://endpoint.example.test/second")).text();

    expect(connections).toBe(1);
  }, 10_000);

  it("injects the proxy span context into the upstream request", async () => {
    clearProxyEnv();
    let traceparent: string | undefined;
    server = createServer((req, res) => {
      traceparent = req.headers.traceparent;
      res.end("ok");
    });
    await new Promise<void>((resolve) => server?.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    process.env.INTROSPECTION_EGRESS_URL = `http://127.0.0.1:${port}`;
    process.env.INTROSPECTION_ENDPOINT_HOSTS = "endpoint.example.test";

    const response = await createProxyFetch()(
      "http://endpoint.example.test/mcp",
      { method: "POST", body: "{}" },
    );

    expect(response.status).toBe(200);
    const span = exporter.getFinishedSpans()[0];
    expect(traceparent).toMatch(
      new RegExp(
        `^00-${span.spanContext().traceId}-${span.spanContext().spanId}-01$`,
      ),
    );
  });

  it("propagates baggage only when explicitly enabled", async () => {
    clearProxyEnv();
    const baggageHeaders: Array<string | undefined> = [];
    server = createServer((req, res) => {
      baggageHeaders.push(req.headers.baggage);
      res.end("ok");
    });
    await new Promise<void>((resolve) => server?.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    process.env.INTROSPECTION_EGRESS_URL = `http://127.0.0.1:${port}`;
    process.env.INTROSPECTION_ENDPOINT_HOSTS = "endpoint.example.test";
    const baggageContext = propagation.setBaggage(
      context.active(),
      propagation.createBaggage({
        "gen_ai.conversation.id": { value: "conversation-1" },
      }),
    );

    await context.with(baggageContext, () =>
      createProxyFetch()("http://endpoint.example.test/mcp"),
    );
    await context.with(baggageContext, () =>
      createProxyFetch({ propagateBaggage: true })(
        "http://endpoint.example.test/mcp",
      ),
    );

    expect(baggageHeaders).toEqual([
      undefined,
      "gen_ai.conversation.id=conversation-1",
    ]);
  });

  it("emits a forward-mode error-status span for a 5xx response", async () => {
    clearProxyEnv();
    const port = await listen(503);
    process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;

    const proxyFetch = createProxyFetch();
    const response = await proxyFetch("http://forwarded.example.test/health");
    expect(response.status).toBe(503);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].attributes["introspection.proxy.mode"]).toBe("forward");
    expect(spans[0].attributes["http.response.status_code"]).toBe(503);
    expect(spans[0].status.code).toBe(SpanStatusCode.ERROR);
  });

  it("does not span a NO_PROXY host that EnvHttpProxyAgent sends direct", async () => {
    clearProxyEnv();
    const port = await listen(200);
    // Bogus forward proxy: if the request were actually proxied it would fail.
    process.env.HTTP_PROXY = "http://127.0.0.1:1";
    process.env.NO_PROXY = "127.0.0.1";

    const proxyFetch = createProxyFetch();
    const response = await proxyFetch(`http://127.0.0.1:${port}/direct`);
    expect(response.status).toBe(200);

    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  it("does not span when tracing is disabled", async () => {
    clearProxyEnv();
    const port = await listen(200);
    process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;

    const proxyFetch = createProxyFetch({ tracing: false });
    const response = await proxyFetch("http://forwarded.example.test/health");
    expect(response.status).toBe(200);

    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});
