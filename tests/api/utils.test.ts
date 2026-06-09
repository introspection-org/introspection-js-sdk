/**
 * Coverage for utils.ts — the HTTPS-proxy OTLP option wrapper and the
 * diagnostic logger. Pure logic; no mocks. Log-level branches are exercised by
 * re-importing the module under different `INTROSPECTION_LOG_LEVEL` values via
 * `vi.resetModules()` (a module-cache reset, not a mock).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  withOtlpHttpsProxy,
  logger,
} from "../../packages/introspection-node/src/utils";

describe("withOtlpHttpsProxy", () => {
  // Resolution reads the full proxy env (proxy-from-env is scheme-aware), so
  // snapshot and clear all of them around each case for a clean slate.
  const PROXY_ENV = [
    "HTTP_PROXY",
    "http_proxy",
    "HTTPS_PROXY",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
    "ALL_PROXY",
    "all_proxy",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const key of PROXY_ENV) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of PROXY_ENV) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("returns options unchanged when no proxy is configured", () => {
    const opts = { url: "https://example.com", headers: {} };
    expect(withOtlpHttpsProxy(opts)).toBe(opts);
  });

  it("adds an httpAgentOptions factory for an https endpoint behind HTTPS_PROXY", () => {
    process.env.HTTPS_PROXY = "http://127.0.0.1:8888";
    const out = withOtlpHttpsProxy({ url: "https://example.com" }) as {
      httpAgentOptions: () => unknown;
    };
    expect(typeof out.httpAgentOptions).toBe("function");
    // Invoking it constructs a real HttpsProxyAgent.
    expect(out.httpAgentOptions()).toBeDefined();
  });

  it("selects HTTP_PROXY for an http endpoint (scheme-aware resolution)", () => {
    process.env.HTTP_PROXY = "http://127.0.0.1:8888";
    const out = withOtlpHttpsProxy({
      url: "http://collector.example/v1/traces",
    }) as { httpAgentOptions?: () => unknown };
    expect(typeof out.httpAgentOptions).toBe("function");
  });

  it("skips the proxy when the OTLP endpoint matches NO_PROXY", () => {
    // HTTP_PROXY is set, so only NO_PROXY can keep this in-cluster endpoint
    // on a direct connection.
    process.env.HTTP_PROXY = "http://127.0.0.1:8888";
    process.env.NO_PROXY = ".svc.cluster.local";
    const opts = {
      url: "http://introspection-gateway-internal-otel.envoy-gateway-system.svc.cluster.local/v1/traces",
      headers: {},
    };
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
