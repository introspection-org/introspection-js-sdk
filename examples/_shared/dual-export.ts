/**
 * Shared dual-export helpers for the examples.
 *
 * Each helper returns a fully-wired OTel {@link SpanProcessor} for a third-party
 * tracing backend, ready to drop into an explicit provider alongside the
 * {@link IntrospectionSpanProcessor}:
 *
 * ```ts
 * const provider = new NodeTracerProvider({
 *   spanProcessors: [
 *     new IntrospectionSpanProcessor({ token: process.env.INTROSPECTION_TOKEN }),
 *     langfuseSpanProcessor(),
 *   ],
 * });
 * provider.register();
 * ```
 *
 * The Introspection processor forwards its own converted copy of each span to
 * Introspection; these vendor processors receive the raw span and export it to
 * their backend independently. Processor order is therefore irrelevant.
 *
 * Phase 5 of the cleanup plan extends this file with `arizeSpanProcessor`,
 * `braintrustSpanProcessor`, and `langsmithSpanProcessor`.
 */
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  BatchSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

/**
 * Resolved Langfuse OTLP endpoint + Basic-auth headers.
 *
 * Required env vars:
 *   - `LANGFUSE_PUBLIC_KEY`
 *   - `LANGFUSE_SECRET_KEY`
 *   - `LANGFUSE_BASE_URL` (optional, defaults to Langfuse Cloud)
 */
export function langfuseOtlpConfig(): {
  url: string;
  headers: Record<string, string>;
} {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    throw new Error(
      "LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set for the Langfuse dual-export example.",
    );
  }
  const auth = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  const baseUrl = process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com";
  return {
    url: `${baseUrl}/api/public/otel/v1/traces`,
    headers: { Authorization: `Basic ${auth}` },
  };
}

/** A raw Langfuse OTLP trace exporter — for frameworks that compose exporters. */
export function langfuseOtelExporter(): OTLPTraceExporter {
  return new OTLPTraceExporter(langfuseOtlpConfig());
}

/** A Langfuse span processor — for an explicit OTel provider's processor list. */
export function langfuseSpanProcessor(): SpanProcessor {
  return new BatchSpanProcessor(langfuseOtelExporter());
}
