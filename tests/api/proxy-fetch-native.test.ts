/**
 * Proxy-native egress: `INTROSPECTION_EGRESS_PROXY_NATIVE=1` routes every
 * request through `HTTPS_PROXY` as a CONNECT tunnel carrying the session
 * credential, trusting the platform CA, with no egress rewrite.
 *
 * No recordings: the proxy and upstream are local servers, and the assertions
 * are about the bytes on the wire to them.
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  context,
  propagation,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createProxyFetch,
  PROXY_CALL_SPAN_NAME,
} from "../../packages/introspection-proxy/src/index";

const CHILD_SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/proxy-native-child.mjs",
);
const LOCATOR = "loc-0123456789";
const EXPECTED_PROXY_AUTH = `Basic ${Buffer.from(`session:${LOCATOR}`).toString("base64")}`;

const ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "INTROSPECTION_EGRESS_PROXY_NATIVE",
  "INTROSPECTION_EGRESS_URL",
  "INTROSPECTION_ENDPOINT_HOSTS",
  "INTROSPECTION_RELAY_TARGET",
];
const ORIGINAL_ENV = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
);

function resetEnv(): void {
  for (const key of ENV_KEYS) delete process.env[key];
}

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

interface TlsMaterial {
  dir: string;
  caFile: string;
  ca: string;
  cert: string;
  key: string;
}

function createTestCa(): TlsMaterial {
  const dir = mkdtempSync(join(tmpdir(), "proxy-native-"));
  const path = (name: string) => join(dir, name);
  const openssl = (...args: string[]) =>
    execFileSync("openssl", args, { stdio: "ignore" });
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1"];
  openssl(
    "req",
    "-x509",
    ...ec,
    "-nodes",
    "-keyout",
    path("ca.key"),
    "-out",
    path("ca.pem"),
    "-days",
    "2",
    "-subj",
    "/CN=Introspection Test Platform CA",
    "-addext",
    "basicConstraints=critical,CA:TRUE",
    "-addext",
    "keyUsage=critical,keyCertSign,cRLSign",
  );
  openssl(
    "req",
    ...ec,
    "-nodes",
    "-keyout",
    path("server.key"),
    "-out",
    path("server.csr"),
    "-subj",
    "/CN=localhost",
  );
  writeFileSync(
    path("server.ext"),
    [
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
      "basicConstraints=CA:FALSE",
      "keyUsage=critical,digitalSignature",
      "extendedKeyUsage=serverAuth",
    ].join("\n"),
  );
  openssl(
    "x509",
    "-req",
    "-in",
    path("server.csr"),
    "-CA",
    path("ca.pem"),
    "-CAkey",
    path("ca.key"),
    "-CAcreateserial",
    "-out",
    path("server.pem"),
    "-days",
    "2",
    "-extfile",
    path("server.ext"),
  );
  return {
    dir,
    caFile: path("ca.pem"),
    ca: readFileSync(path("ca.pem"), "utf8"),
    cert: readFileSync(path("server.pem"), "utf8"),
    key: readFileSync(path("server.key"), "utf8"),
  };
}

interface ConnectRecord {
  target: string | undefined;
  proxyAuthorization: string | undefined;
}

interface UpstreamRecord {
  url: string | undefined;
  host: string | undefined;
  traceparent: string | undefined;
  proxyAuthorization: string | undefined;
  relayTarget: string | undefined;
  egressHost: string | undefined;
}

/** Destroy every socket a server accepted, tunnels included, then close it. */
function trackSockets(server: Server): () => Promise<void> {
  const sockets = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((done) => server.close(done));
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return (server.address() as AddressInfo).port;
}

describe("proxy-native egress", () => {
  const exporter = new InMemorySpanExporter();
  trace.setGlobalTracerProvider(
    new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    }),
  );
  context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());

  let tls: TlsMaterial;
  let upstreamPort: number;
  let httpProxyPort: number;
  let httpsProxyPort: number;
  const closers: Array<() => Promise<void>> = [];
  const upstream: UpstreamRecord[] = [];
  const connects: ConnectRecord[] = [];
  let upstreamConnections = 0;

  function onConnect(
    req: { url?: string; headers: Record<string, unknown> },
    client: Socket,
    head: Buffer,
  ): void {
    const proxyAuthorization = req.headers["proxy-authorization"] as
      string | undefined;
    connects.push({ target: req.url, proxyAuthorization });
    if (proxyAuthorization !== EXPECTED_PROXY_AUTH) {
      client.end(
        "HTTP/1.1 407 Proxy Authentication Required\r\n" +
          'Proxy-Authenticate: Basic realm="egress"\r\n' +
          "Content-Length: 0\r\n\r\n",
      );
      return;
    }
    const [host, port] = (req.url ?? "").split(":");
    const tunnel = connect(Number(port), host, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      tunnel.write(head);
      tunnel.pipe(client);
      client.pipe(tunnel);
    });
    tunnel.on("error", () => client.destroy());
    client.on("error", () => tunnel.destroy());
  }

  beforeAll(async () => {
    tls = createTestCa();
    setDefaultCACertificates([...getCACertificates("default"), tls.ca]);

    const upstreamServer = createHttpsServer(
      { cert: tls.cert, key: tls.key },
      (req, res) => {
        const header = (name: string) =>
          req.headers[name] as string | undefined;
        upstream.push({
          url: req.url,
          host: req.headers.host,
          traceparent: header("traceparent"),
          proxyAuthorization: header("proxy-authorization"),
          relayTarget: header("x-introspection-relay-target"),
          egressHost: header("x-introspection-egress-host"),
        });
        res.setHeader("Connection", "keep-alive");
        res.end("upstream-ok");
      },
    );
    upstreamServer.on("connection", () => {
      upstreamConnections += 1;
    });
    closers.push(trackSockets(upstreamServer));
    upstreamPort = await listen(upstreamServer);

    const httpProxy = createHttpServer();
    httpProxy.on("connect", onConnect);
    closers.push(trackSockets(httpProxy));
    httpProxyPort = await listen(httpProxy);

    const httpsProxy = createHttpsServer({ cert: tls.cert, key: tls.key });
    httpsProxy.on("connect", onConnect);
    closers.push(trackSockets(httpsProxy));
    httpsProxyPort = await listen(httpsProxy);
  });

  afterAll(async () => {
    restoreEnv();
    await Promise.all(closers.map((close) => close()));
    rmSync(tls.dir, { recursive: true, force: true });
  });

  afterEach(() => {
    restoreEnv();
    exporter.reset();
    upstream.length = 0;
    connects.length = 0;
    upstreamConnections = 0;
  });

  function useNativeProxy(proxyUrl: string): void {
    resetEnv();
    process.env.INTROSPECTION_EGRESS_PROXY_NATIVE = "1";
    process.env.HTTPS_PROXY = proxyUrl;
    // A plane that still projected the legacy carriers must not pull a
    // native runtime back onto the egress rewrite.
    process.env.INTROSPECTION_EGRESS_URL = "http://127.0.0.1:1";
    process.env.INTROSPECTION_ENDPOINT_HOSTS = "localhost";
    process.env.INTROSPECTION_RELAY_TARGET = "dev-relay";
  }

  it("tunnels through HTTPS_PROXY with the credential and NODE_EXTRA_CA_CERTS", async () => {
    const env: NodeJS.ProcessEnv = {
      NODE_EXTRA_CA_CERTS: tls.caFile,
      INTROSPECTION_EGRESS_PROXY_NATIVE: "1",
      HTTPS_PROXY: `http://session:${LOCATOR}@127.0.0.1:${httpProxyPort}`,
      INTROSPECTION_EGRESS_URL: "http://127.0.0.1:1",
      INTROSPECTION_ENDPOINT_HOSTS: "localhost",
    };
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [CHILD_SCRIPT, `https://localhost:${upstreamPort}/v1/models?beta=true`],
      { env, timeout: 30_000 },
    );
    const result = JSON.parse(stdout) as {
      status: number;
      body: string;
      spans: Array<{
        name: string;
        traceId: string;
        spanId: string;
        attributes: Record<string, unknown>;
      }>;
    };

    expect(result.status).toBe(200);
    expect(result.body).toBe("upstream-ok");
    expect(connects).toEqual([
      {
        target: `localhost:${upstreamPort}`,
        proxyAuthorization: EXPECTED_PROXY_AUTH,
      },
    ]);
    expect(result.spans).toHaveLength(1);
    const [span] = result.spans;
    expect(span.name).toBe(PROXY_CALL_SPAN_NAME);
    expect(span.attributes["introspection.proxy.mode"]).toBe("forward");
    expect(span.attributes["url.full"]).toBe(
      `https://localhost:${upstreamPort}/v1/models`,
    );
    expect(upstream).toEqual([
      {
        url: "/v1/models?beta=true",
        host: `localhost:${upstreamPort}`,
        traceparent: `00-${span.traceId}-${span.spanId}-01`,
        proxyAuthorization: undefined,
        relayTarget: undefined,
        egressHost: undefined,
      },
    ]);
  });

  it.each([
    [
      "an in-cluster http",
      () => `http://session:${LOCATOR}@127.0.0.1:${httpProxyPort}`,
    ],
    [
      "an external https",
      () => `https://session:${LOCATOR}@localhost:${httpsProxyPort}`,
    ],
  ])(
    "ignores the legacy egress carriers behind %s proxy",
    async (_, proxyUrl) => {
      useNativeProxy(proxyUrl());

      const response = await createProxyFetch()(
        `https://localhost:${upstreamPort}/v1/messages`,
        { method: "POST", body: "{}" },
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("upstream-ok");
      expect(connects).toEqual([
        {
          target: `localhost:${upstreamPort}`,
          proxyAuthorization: EXPECTED_PROXY_AUTH,
        },
      ]);
      const [span] = exporter.getFinishedSpans();
      expect(span.attributes["introspection.proxy.mode"]).toBe("forward");
      expect(upstream).toEqual([
        {
          url: "/v1/messages",
          host: `localhost:${upstreamPort}`,
          traceparent: `00-${span.spanContext().traceId}-${span.spanContext().spanId}-01`,
          proxyAuthorization: undefined,
          relayTarget: undefined,
          egressHost: undefined,
        },
      ]);
    },
  );

  it("treats an unset INTROSPECTION_EGRESS_URL as proxy-native", async () => {
    resetEnv();
    process.env.HTTPS_PROXY = `http://session:${LOCATOR}@127.0.0.1:${httpProxyPort}`;
    process.env.INTROSPECTION_ENDPOINT_HOSTS = "localhost";
    process.env.INTROSPECTION_RELAY_TARGET = "dev-relay";

    const response = await createProxyFetch()(
      `https://localhost:${upstreamPort}/v1/messages`,
    );

    expect(response.status).toBe(200);
    expect(connects).toHaveLength(1);
    expect(upstream[0].relayTarget).toBeUndefined();
    expect(upstream[0].egressHost).toBeUndefined();
  });

  it("fails the span when the proxy rejects a missing credential", async () => {
    useNativeProxy(`http://127.0.0.1:${httpProxyPort}`);

    await expect(
      createProxyFetch()(`https://localhost:${upstreamPort}/v1/models`),
    ).rejects.toThrow();

    expect(connects).toEqual([
      { target: `localhost:${upstreamPort}`, proxyAuthorization: undefined },
    ]);
    expect(upstream).toHaveLength(0);
    const [span] = exporter.getFinishedSpans();
    expect(span.name).toBe(PROXY_CALL_SPAN_NAME);
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
  });

  it("keeps the tunnel open between model calls", async () => {
    useNativeProxy(`http://session:${LOCATOR}@127.0.0.1:${httpProxyPort}`);

    const proxyFetch = createProxyFetch({ tracing: false });
    const target = `https://localhost:${upstreamPort}`;
    await (await proxyFetch(`${target}/first`)).text();
    await new Promise((done) => setTimeout(done, 4_100));
    await (await proxyFetch(`${target}/second`)).text();

    expect(connects).toHaveLength(1);
    expect(upstreamConnections).toBe(1);
  }, 10_000);
});
