import {
  SpanKind,
  SpanStatusCode,
  trace,
  type Attributes,
  type Tracer,
} from "@opentelemetry/api";
import { GenAi } from "@introspection-sdk/types";

/**
 * How a driver reports its model calls. Every call becomes an OTel GenAI
 * client span carrying `gen_ai.usage.*`, the same shape
 * `@introspection-sdk/introspection-pi` gives a Pi chat call, so usage from
 * inside the `browser` tool reaches the same aggregations and billing.
 */
export interface DriverTelemetry {
  /** Defaults to the global tracer provider's tracer for this package. */
  tracer?: Tracer;
  /**
   * Host attributes for every span, read per call — e.g.
   * `introspection.byok` from the host, which knows whether the call went
   * through a managed route.
   */
  attributes?: () => Attributes;
}

export interface ModelCall {
  /** `gen_ai.operation.name`: `chat`, or `generate_content` for Jev. */
  operation: string;
  /** `gen_ai.provider.name`. */
  provider: string;
  /** `gen_ai.request.model`. */
  model: string;
  /** The request URL, for `server.address` / `server.port`. */
  url?: string;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  responseModel?: string;
  responseId?: string;
}

const TRACER_NAME = "@introspection-sdk/browser-agent";

function serverAttributes(url: string | undefined): Attributes {
  if (!url) return {};
  try {
    const parsed = new URL(url);
    const port = parsed.port
      ? Number(parsed.port)
      : parsed.protocol === "http:"
        ? 80
        : 443;
    return { "server.address": parsed.hostname, "server.port": port };
  } catch {
    return {};
  }
}

function usageAttributes(usage: ModelUsage): Attributes {
  const attributes: Attributes = {};
  // Semconv: both cache counts are subsets of the input total.
  const input =
    (usage.inputTokens ?? 0) +
    (usage.cacheReadInputTokens ?? 0) +
    (usage.cacheCreationInputTokens ?? 0);
  if (usage.inputTokens !== undefined)
    attributes[GenAi.USAGE_INPUT_TOKENS] = input;
  if (usage.outputTokens !== undefined)
    attributes[GenAi.USAGE_OUTPUT_TOKENS] = usage.outputTokens;
  if (usage.cacheReadInputTokens)
    attributes[GenAi.USAGE_CACHE_READ_INPUT_TOKENS] =
      usage.cacheReadInputTokens;
  if (usage.cacheCreationInputTokens)
    attributes[GenAi.USAGE_CACHE_CREATION_INPUT_TOKENS] =
      usage.cacheCreationInputTokens;
  if (usage.responseModel)
    attributes[GenAi.RESPONSE_MODEL] = usage.responseModel;
  if (usage.responseId) attributes[GenAi.RESPONSE_ID] = usage.responseId;
  return attributes;
}

function errorType(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const status = /\bHTTP ([45]\d{2})\b/.exec(message)?.[1];
  if (status) return status;
  return error instanceof Error && error.name !== "Error"
    ? error.name
    : "exception";
}

/**
 * Runs one model call inside a `{operation} {model}` CLIENT span. `run`
 * returns the value and the usage the provider reported; a throw ends the
 * span as an error and is rethrown. `false` turns tracing off for callers
 * whose client is already instrumented.
 */
export async function traceModelCall<T>(
  telemetry: DriverTelemetry | false | undefined,
  call: ModelCall,
  run: () => Promise<{ value: T; usage?: ModelUsage }>,
): Promise<T> {
  if (telemetry === false) return (await run()).value;
  const tracer = telemetry?.tracer ?? trace.getTracer(TRACER_NAME);
  const span = tracer.startSpan(`${call.operation} ${call.model}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      [GenAi.OPERATION_NAME]: call.operation,
      [GenAi.PROVIDER_NAME]: call.provider,
      [GenAi.REQUEST_MODEL]: call.model,
      ...serverAttributes(call.url),
      ...telemetry?.attributes?.(),
    },
  });
  try {
    const { value, usage } = await run();
    if (usage) span.setAttributes(usageAttributes(usage));
    return value;
  } catch (error) {
    span.setAttribute("error.type", errorType(error));
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    span.end();
  }
}
