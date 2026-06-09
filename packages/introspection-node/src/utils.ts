import { DiagLogLevel, DiagLogger } from "@opentelemetry/api";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";

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
    const logLevelStr = (
      process.env.INTROSPECTION_LOG_LEVEL || "INFO"
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
        return DiagLogLevel.INFO;
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
