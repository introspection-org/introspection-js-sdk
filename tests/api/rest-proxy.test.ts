import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { HttpClient } from "@introspection-sdk/introspection-node";
import { NetworkError } from "@introspection-sdk/types";

const PROXY_ENV = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "http_proxy",
  "https_proxy",
  "NO_PROXY",
  "no_proxy",
  "NODE_USE_ENV_PROXY",
  "INTROSPECTION_EGRESS_URL",
] as const;
const ORIGINAL_ENV = Object.fromEntries(
  PROXY_ENV.map((key) => [key, process.env[key]]),
);

let server: Server | undefined;

afterEach(async () => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (server) {
    await new Promise((resolve) => server?.close(resolve));
    server = undefined;
  }
});

/** A local server that answers every request and records what it was asked. */
async function listen(seen: string[]): Promise<number> {
  server = createServer((req, res) => {
    seen.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server?.listen(0, resolve));
  return (server.address() as AddressInfo).port;
}

function clearProxyEnv(): void {
  for (const key of PROXY_ENV) delete process.env[key];
}

describe("REST calls behind a forward proxy", () => {
  it("route through HTTP(S)_PROXY, which Node's fetch ignores on its own", async () => {
    clearProxyEnv();
    const seen: string[] = [];
    const port = await listen(seen);
    process.env.HTTP_PROXY = `http://127.0.0.1:${port}`;
    process.env.HTTPS_PROXY = `http://127.0.0.1:${port}`;
    const client = new HttpClient({
      apiUrl: "http://api.proxied.example.test",
      token: "t",
    });

    const body = await client.request<{ ok: boolean }>({
      method: "GET",
      path: "/v1/tasks",
    });

    expect(body).toEqual({ ok: true });
    // A forward proxy is asked for the absolute URL of the real host.
    expect(seen).toEqual(["http://api.proxied.example.test/v1/tasks"]);
  });

  it("leave routing to the sandbox runtime when its egress proxy is set", async () => {
    clearProxyEnv();
    const seen: string[] = [];
    const port = await listen(seen);
    process.env.HTTP_PROXY = "http://127.0.0.1:1";
    process.env.INTROSPECTION_EGRESS_URL = "http://127.0.0.1:1";
    const client = new HttpClient({
      apiUrl: `http://127.0.0.1:${port}`,
      token: "t",
    });

    await client.request({ method: "GET", path: "/v1/tasks" });

    expect(seen).toEqual(["/v1/tasks"]);
  });
});

describe("a fetch installed after the SDK loaded", () => {
  it("still sees REST calls when a proxy is set", async () => {
    clearProxyEnv();
    process.env.HTTPS_PROXY = "http://127.0.0.1:9";
    const original = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const client = new HttpClient({
        apiUrl: "https://api.intercepted.example.test",
        token: "t",
      });
      await client.request({ method: "GET", path: "/v1/tasks" });
    } finally {
      globalThis.fetch = original;
    }

    expect(seen).toEqual(["https://api.intercepted.example.test/v1/tasks"]);
  });
});

describe("a transport failure", () => {
  it("names the request's host and the underlying cause", async () => {
    clearProxyEnv();
    const port = await listen([]);
    await new Promise((resolve) => server?.close(resolve));
    server = undefined;
    const client = new HttpClient({
      apiUrl: `http://127.0.0.1:${port}`,
      token: "t",
    });

    const err = await client
      .request({ method: "GET", path: "/v1/tasks", query: { secret: "x" } })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(err).toBeInstanceOf(NetworkError);
    const message = (err as NetworkError).message;
    expect(message.startsWith(`GET 127.0.0.1:${port}/v1/tasks failed: `)).toBe(
      true,
    );
    expect(message).toContain("ECONNREFUSED");
    expect(message).not.toContain("secret");
  });
});
