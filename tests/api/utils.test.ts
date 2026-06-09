/**
 * Coverage for utils.ts — the HTTPS-proxy OTLP option wrapper and the
 * diagnostic logger. Pure logic; no mocks. Log-level branches are exercised by
 * re-importing the module under different `INTROSPECTION_LOG_LEVEL` values via
 * `vi.resetModules()` (a module-cache reset, not a mock).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  withOtlpHttpsProxy,
  logger,
} from "../../packages/introspection-node/src/utils";

describe("withOtlpHttpsProxy", () => {
  const prevProxy = process.env.HTTPS_PROXY;
  const prevNoProxy = process.env.NO_PROXY;
  afterEach(() => {
    if (prevProxy === undefined) delete process.env.HTTPS_PROXY;
    else process.env.HTTPS_PROXY = prevProxy;
    if (prevNoProxy === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = prevNoProxy;
  });

  it("returns options unchanged when no proxy is configured", () => {
    delete process.env.HTTPS_PROXY;
    const opts = { url: "https://example.com", headers: {} };
    expect(withOtlpHttpsProxy(opts)).toBe(opts);
  });

  it("adds an httpAgentOptions factory when HTTPS_PROXY is set", () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:8888";
    delete process.env.NO_PROXY;
    const out = withOtlpHttpsProxy({ url: "https://example.com" }) as {
      httpAgentOptions: () => unknown;
    };
    expect(typeof out.httpAgentOptions).toBe("function");
    // Invoking it constructs a real HttpsProxyAgent.
    expect(out.httpAgentOptions()).toBeDefined();
  });

  it("skips the proxy when the OTLP endpoint matches NO_PROXY", () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:8888";
    process.env.NO_PROXY = ".svc.cluster.local";
    const opts = {
      url: "http://introspection-gateway-internal-otel.envoy-gateway-system.svc.cluster.local/v1/traces",
      headers: {},
    };
    // In-cluster endpoint bypasses the egress proxy: options returned as-is.
    expect(withOtlpHttpsProxy(opts)).toBe(opts);
  });
});

describe("logger", () => {
  it("exposes the five diag methods without throwing at the default level", () => {
    // Default level is INFO: info/warn/error log, debug/verbose are gated off.
    expect(() => {
      logger.error("e");
      logger.warn("w");
      logger.info("i");
      logger.debug("d");
      logger.verbose("v");
    }).not.toThrow();
  });

  it("parses each log level and gates output accordingly", async () => {
    // Re-import under each level so the singleton's parseLogLevel + shouldLog
    // branches are all exercised. ERROR is last so post-test console noise is
    // minimal; output isn't asserted, only that the logic runs.
    const levels = ["WARN", "DEBUG", "VERBOSE", "BOGUS", "ERROR"] as const;
    const prev = process.env.INTROSPECTION_LOG_LEVEL;
    try {
      for (const level of levels) {
        process.env.INTROSPECTION_LOG_LEVEL = level;
        vi.resetModules();
        const mod = await import("../../packages/introspection-node/src/utils");
        expect(() => {
          mod.logger.error("e");
          mod.logger.warn("w");
          mod.logger.info("i");
          mod.logger.debug("d");
          mod.logger.verbose("v");
        }).not.toThrow();
      }
    } finally {
      if (prev === undefined) delete process.env.INTROSPECTION_LOG_LEVEL;
      else process.env.INTROSPECTION_LOG_LEVEL = prev;
      vi.resetModules();
    }
  });
});
