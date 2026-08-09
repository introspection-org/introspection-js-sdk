import { DiagLogLevel, DiagLogger } from "@opentelemetry/api";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";

import { VERSION } from "./version.js";

/**
 * `service.name` for telemetry this SDK emits when the caller names none.
 *
 * One constant for both streams. `init()` used to label its own provider
 * only when a name was supplied, so spans arrived as `unknown_service:node`
 * while the events beside them said `introspection-client` — one process,
 * two services, nothing tying them together. The Python and Rust SDKs
 * default both streams to this same string.
 */
export const DEFAULT_SERVICE_NAME = "introspection-client";

/**
 * Headers for an OTLP exporter pointed at Introspection.
 *
 * Shared by both streams. `User-Agent` matches what the Python and Rust
 * SDKs send on their traces *and* logs exporters; Node used to send it on
 * logs only, so exported spans arrived at the collector unattributable to
 * a client or a release.
 *
 * `Authorization` is omitted for an empty token rather than sent as a bare
 * `Bearer `. A tokenless client is either warned about (logs) or running a
 * caller-supplied exporter that carries its own auth (spans), and neither
 * wants a malformed credential on the wire.
 *
 * Caller headers are merged last so they can override either.
 */
export function exporterHeaders(
  token: string | undefined,
  additionalHeaders?: Record<string, string>,
): Record<string, string> {
  return {
    "User-Agent": `introspection-sdk/${VERSION}`,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(additionalHeaders || {}),
  };
}

/**
 * Attach a forward-proxy agent to OTLP exporter options when a proxy is
 * configured for the exporter's endpoint.
 *
 * The OTLP proto exporters use Node's `http`/`https` stack, so this uses
 * `HttpsProxyAgent` (an `http.Agent`) rather than the undici dispatcher from
 * `@introspection-sdk/introspection-proxy` — a dispatcher only applies to
 * `fetch`. Unlike undici's `EnvHttpProxyAgent`, `HttpsProxyAgent` ignores
 * `NO_PROXY`, so we resolve the proxy per-endpoint with `proxy-from-env`'s
 * {@link getProxyForUrl}, which returns `""` when the host matches `NO_PROXY`.
 * This keeps in-cluster endpoints (e.g. `*.svc.cluster.local`) on a direct
 * connection instead of tunnelling them through the egress proxy, which has no
 * route for them.
 */
export function withOtlpHttpsProxy<T extends { url?: string }>(options: T): T {
  const proxyUrl = options.url ? getProxyForUrl(options.url) : "";
  if (!proxyUrl) return options;

  return {
    ...options,
    httpAgentOptions: () => new HttpsProxyAgent(proxyUrl),
  } as T;
}

/**
 * Logger for introspection-sdk package.
 * Uses OpenTelemetry's diagnostic logger.
 */
class IntrospectionLogger implements DiagLogger {
  private logLevel: DiagLogLevel;

  constructor() {
    // WARN, because these methods write straight to `console`. At INFO —
    // the old default — merely constructing a client or a span processor
    // printed lines onto an application's stdout that nobody asked for.
    // The Python SDK attaches a NullHandler and inherits the application's
    // level; the Rust SDK emits through `tracing` and prints nothing
    // without a subscriber. A library should be quiet unless asked.
    // `INTROSPECTION_LOG_LEVEL=info` asks.
    const logLevelStr = (
      process.env.INTROSPECTION_LOG_LEVEL || "WARN"
    ).toUpperCase();
    this.logLevel = this.parseLogLevel(logLevelStr);
  }

  private parseLogLevel(level: string): DiagLogLevel {
    switch (level) {
      case "ERROR":
        return DiagLogLevel.ERROR;
      case "WARN":
        return DiagLogLevel.WARN;
      case "INFO":
        return DiagLogLevel.INFO;
      case "DEBUG":
        return DiagLogLevel.DEBUG;
      case "VERBOSE":
        return DiagLogLevel.VERBOSE;
      default:
        return DiagLogLevel.WARN;
    }
  }

  private shouldLog(level: DiagLogLevel): boolean {
    return level <= this.logLevel;
  }

  error(...args: unknown[]): void {
    if (this.shouldLog(DiagLogLevel.ERROR)) {
      console.error("[introspection-sdk]", ...args);
    }
  }

  warn(...args: unknown[]): void {
    if (this.shouldLog(DiagLogLevel.WARN)) {
      console.warn("[introspection-sdk]", ...args);
    }
  }

  info(...args: unknown[]): void {
    if (this.shouldLog(DiagLogLevel.INFO)) {
      console.info("[introspection-sdk]", ...args);
    }
  }

  debug(...args: unknown[]): void {
    if (this.shouldLog(DiagLogLevel.DEBUG)) {
      console.debug("[introspection-sdk]", ...args);
    }
  }

  verbose(...args: unknown[]): void {
    if (this.shouldLog(DiagLogLevel.VERBOSE)) {
      console.debug("[introspection-sdk]", ...args);
    }
  }
}

export const logger = new IntrospectionLogger();
