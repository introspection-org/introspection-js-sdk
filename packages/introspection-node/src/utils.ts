import { DiagLogLevel, DiagLogger } from "@opentelemetry/api";

import { VERSION } from "./version.js";

/**
 * `service.name` for telemetry this SDK emits when the caller names none.
 *
 * One constant for both streams. `init()` used to label its own provider
 * only when a name was supplied, so spans arrived as `unknown_service:node`
 * while the events beside them said `introspection-client` — one process,
 * two services, nothing tying them together.
 */
export const DEFAULT_SERVICE_NAME = "introspection-client";

/**
 * Headers for an OTLP exporter pointed at Introspection.
 *
 * Shared by both streams. `User-Agent` used to ride the logs exporter only,
 * so exported spans arrived at the collector unattributable to a client or a
 * release.
 *
 * `Authorization` is omitted for an empty token rather than sent as a bare
 * `Bearer `. A tokenless client is either warned about (logs) or running a
 * caller-supplied exporter that carries its own auth (spans), and neither
 * wants a malformed credential on the wire.
 *
 * Caller headers are merged last so they can override either.
 */
export const USER_AGENT = `introspection-js-sdk/${VERSION}`;

/**
 * The OTLP HTTP transport takes the client's user agent as a dedicated option
 * rather than a header: it assigns `headers['User-Agent']` unconditionally
 * just before the request, so a `User-Agent` supplied through `headers` is
 * always discarded. Passing it here instead prepends it to the exporter's own
 * token, and exports arrive attributable to a client and a release.
 */
export const otlpUserAgent = { userAgent: USER_AGENT } as const;

export function exporterHeaders(
  token: string | undefined,
  additionalHeaders?: Record<string, string>,
): Record<string, string> {
  return {
    "User-Agent": USER_AGENT,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(additionalHeaders || {}),
  };
}

export { withOtlpHttpsProxy } from "@introspection-sdk/introspection-proxy/otlp";

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
    // A library should be quiet unless asked.
    // `INTROSPECTION_LOG_LEVEL=info` asks.
    const logLevelStr = (
      process.env.INTROSPECTION_LOG_LEVEL || "WARN"
    ).toUpperCase();
    this.logLevel = this.parseLogLevel(logLevelStr);
  }

  /**
   * Raise the level to DEBUG for `advanced.debug`.
   *
   * `AdvancedOptions.debug` is shared by the browser and Node clients, but
   * only the browser one read it: `init({ advanced: { debug: true } })` in
   * Node was silently inert, and the only way to get debug output was the
   * env var. Lowering is deliberately not offered — an explicit
   * `INTROSPECTION_LOG_LEVEL` should not be undone by a config flag.
   */
  enableDebug(): void {
    if (this.logLevel < DiagLogLevel.DEBUG) {
      this.logLevel = DiagLogLevel.DEBUG;
    }
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

  private write(
    level: DiagLogLevel,
    method: "error" | "warn" | "info" | "debug",
    args: unknown[],
  ): void {
    if (level <= this.logLevel) {
      console[method]("[introspection-sdk]", ...args);
    }
  }

  error(...args: unknown[]): void {
    this.write(DiagLogLevel.ERROR, "error", args);
  }

  warn(...args: unknown[]): void {
    this.write(DiagLogLevel.WARN, "warn", args);
  }

  info(...args: unknown[]): void {
    this.write(DiagLogLevel.INFO, "info", args);
  }

  debug(...args: unknown[]): void {
    this.write(DiagLogLevel.DEBUG, "debug", args);
  }

  verbose(...args: unknown[]): void {
    this.write(DiagLogLevel.VERBOSE, "debug", args);
  }
}

export const logger = new IntrospectionLogger();
