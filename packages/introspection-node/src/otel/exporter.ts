import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { withOtlpHttpsProxy } from "../utils.js";

/** Default OTLP collector base URL when none is configured. */
export const DEFAULT_OTEL_BASE_URL = "https://otel.introspection.dev";

/**
 * Resolve the OTLP traces endpoint for a given base URL.
 *
 * Accepts either a bare collector base URL (with or without a trailing
 * slash) or a full `/v1/traces` endpoint and returns the full endpoint.
 * Falls back to `INTROSPECTION_BASE_OTEL_URL`, then
 * {@link DEFAULT_OTEL_BASE_URL}.
 */
export function resolveTraceEndpoint(baseUrl?: string): string {
  const resolved =
    baseUrl || process.env.INTROSPECTION_BASE_OTEL_URL || DEFAULT_OTEL_BASE_URL;
  if (resolved.endsWith("/v1/traces")) {
    return resolved;
  }
  return `${resolved.replace(/\/$/, "")}/v1/traces`;
}

export interface CreateIntrospectionExporterOptions {
  /** Authentication token (env: INTROSPECTION_TOKEN) */
  token?: string;
  /**
   * Base URL for the OTLP collector, or a full `/v1/traces` endpoint
   * (env: INTROSPECTION_BASE_OTEL_URL, default: "https://otel.introspection.dev")
   */
  baseUrl?: string;
  /** Additional HTTP headers, merged after the `Authorization` header. */
  headers?: Record<string, string>;
}

/**
 * Create a standard OTLP-HTTP {@link SpanExporter} pointed at the
 * Introspection backend with bearer auth.
 *
 * This is a plain exporter — no gen_ai gating or attribute conversion —
 * for hosts that already run their own OpenTelemetry setup (e.g.
 * `@opentelemetry/sdk-node`) and only need Introspection as an export
 * destination. If you want the SDK's span conversion and filtering,
 * use {@link IntrospectionSpanProcessor} instead.
 *
 * @example
 * ```ts
 * import { NodeSDK } from "@opentelemetry/sdk-node";
 * import { createIntrospectionExporter } from "@introspection-sdk/introspection-node/otel";
 *
 * const sdk = new NodeSDK({
 *   traceExporter: createIntrospectionExporter(), // INTROSPECTION_TOKEN from env
 * });
 * sdk.start();
 * ```
 *
 * @example
 * ```ts
 * import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
 * import { createIntrospectionExporter } from "@introspection-sdk/introspection-node/otel";
 *
 * const processor = new BatchSpanProcessor(
 *   createIntrospectionExporter({ token: "sk-intro-…" }),
 * );
 * ```
 */
export function createIntrospectionExporter(
  options: CreateIntrospectionExporterOptions = {},
): SpanExporter {
  const token = options.token || process.env.INTROSPECTION_TOKEN;
  if (!token) {
    throw new Error(
      "createIntrospectionExporter: token is required (pass token or set INTROSPECTION_TOKEN)",
    );
  }

  const endpoint = resolveTraceEndpoint(options.baseUrl);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    ...(options.headers || {}),
  };

  return new OTLPTraceExporter(
    withOtlpHttpsProxy({
      url: endpoint,
      headers,
    }),
  );
}
