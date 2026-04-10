import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

export interface OtelConfig {
  token: string;
  baseUrl: string;
  serviceName: string;
}

let provider: BasicTracerProvider | null = null;

export function initializeOtel(config: OtelConfig): BasicTracerProvider {
  const traceExporter = new OTLPTraceExporter({
    url: `${config.baseUrl}/v1/traces`,
    headers: { Authorization: `Bearer ${config.token}` },
  });

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: config.serviceName,
  });

  provider = new BasicTracerProvider({
    resource,
    spanProcessors: [new BatchSpanProcessor(traceExporter)],
  });

  // Do NOT call provider.register() — keep local to avoid conflicts
  // with other OTEL pipelines (e.g. introspection-node diagnostics).

  return provider;
}

export function getTracer() {
  if (!provider) {
    throw new Error("openclaw-introspection: OTEL not initialized");
  }
  return provider.getTracer(
    "@introspection-sdk/openclaw-introspection",
    "0.1.0",
  );
}

export function shutdownOtel(): Promise<void> {
  if (provider) {
    return provider.shutdown();
  }
  return Promise.resolve();
}
