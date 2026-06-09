import { afterEach, describe, expect, it } from "vitest";

import {
  installProxyFetch,
  shouldBypassProxy,
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

describe("shouldBypassProxy", () => {
  afterEach(() => {
    restoreEnv();
  });

  it("returns false when NO_PROXY is unset", () => {
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    expect(shouldBypassProxy("http://example.com/v1/traces")).toBe(false);
  });

  it("bypasses everything when NO_PROXY is '*'", () => {
    process.env.NO_PROXY = "*";
    expect(shouldBypassProxy("https://any.host.example/path")).toBe(true);
  });

  it("matches a domain-suffix entry against an in-cluster endpoint", () => {
    process.env.NO_PROXY = ".svc.cluster.local,localhost";
    expect(
      shouldBypassProxy(
        "http://introspection-gateway-internal-otel.envoy-gateway-system.svc.cluster.local/v1/traces",
      ),
    ).toBe(true);
  });

  it("matches a suffix entry without a leading dot", () => {
    process.env.NO_PROXY = "svc.cluster.local";
    expect(shouldBypassProxy("http://foo.svc.cluster.local")).toBe(true);
  });

  it("ignores a :port suffix on the entry and matches the host", () => {
    process.env.NO_PROXY = "internal.example:8080";
    expect(shouldBypassProxy("http://internal.example/v1/traces")).toBe(true);
  });

  it("does not bypass hosts outside NO_PROXY", () => {
    process.env.NO_PROXY = ".svc.cluster.local";
    expect(shouldBypassProxy("https://api.introspection.dev/v1/traces")).toBe(
      false,
    );
  });

  it("respects the lowercase no_proxy variant", () => {
    delete process.env.NO_PROXY;
    process.env.no_proxy = "cluster.local";
    expect(shouldBypassProxy("http://gateway.cluster.local")).toBe(true);
  });

  it("returns false for an unparseable url", () => {
    process.env.NO_PROXY = "svc.cluster.local";
    expect(shouldBypassProxy("not a url")).toBe(false);
  });
});
