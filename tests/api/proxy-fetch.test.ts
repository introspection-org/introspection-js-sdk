import { afterEach, describe, expect, it } from "vitest";

import { installProxyFetch } from "../../packages/introspection-proxy/src/index";

const ORIGINAL_ENV = {
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  http_proxy: process.env.http_proxy,
  https_proxy: process.env.https_proxy,
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
