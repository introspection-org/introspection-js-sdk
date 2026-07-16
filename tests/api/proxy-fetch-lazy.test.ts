import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import { installLazyProxyFetch } from "../../packages/introspection-proxy/src/lazy";

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
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("installLazyProxyFetch", () => {
  const originalFetch = globalThis.fetch;
  let server: Server | undefined;

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    restoreEnv();
    vi.restoreAllMocks();
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
      server.close((error) => (error ? reject(error) : resolve()));
    });
    server = undefined;
  });

  it("installs a guard synchronously and restores the original fetch", () => {
    const installation = installLazyProxyFetch();

    expect(globalThis.fetch).not.toBe(originalFetch);
    installation.restore();
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("does not overwrite a fetch installed after the guard", () => {
    const installation = installLazyProxyFetch();
    const replacement = vi.fn<typeof fetch>();
    globalThis.fetch = replacement;

    installation.restore();

    expect(globalThis.fetch).toBe(replacement);
  });

  it("shares initialization between warmup and concurrent requests", async () => {
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.INTROSPECTION_EGRESS_URL;
    delete process.env.INTROSPECTION_ENDPOINT_HOSTS;

    const installation = installLazyProxyFetch();
    const [first, second, response] = await Promise.all([
      installation.ready(),
      installation.ready(),
      globalThis.fetch("data:text/plain,ok"),
    ]);

    expect(first).toBe(second);
    expect(await response.text()).toBe("ok");
  });

  it("routes a request made before ready through the configured proxy", async () => {
    let requestedUrl: string | undefined;
    server = createServer((request, response) => {
      requestedUrl = request.url;
      response.end("proxied");
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing proxy address");

    process.env.HTTP_PROXY = `http://127.0.0.1:${address.port}`;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    delete process.env.INTROSPECTION_EGRESS_URL;
    delete process.env.INTROSPECTION_ENDPOINT_HOSTS;

    installLazyProxyFetch({ tracing: false });
    const response = await globalThis.fetch(
      "http://lazy-proxy.example.test/health",
    );

    expect(await response.text()).toBe("proxied");
    expect(requestedUrl).toBe("http://lazy-proxy.example.test/health");
  });
});
