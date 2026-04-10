import type {
  IdGenerator,
  ReadableSpan,
  SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { ExportResult, ExportResultCode } from "@opentelemetry/core";

/**
 * Generate sequentially incrementing span/trace IDs for testing.
 *
 * This ensures IDs are predictable and reproducible across test runs.
 * First call returns 1, second returns 2, etc.
 */
export class IncrementalIdGenerator implements IdGenerator {
  private traceIdCounter = 0;
  private spanIdCounter = 0;

  generateTraceId(): string {
    this.traceIdCounter++;
    // OTel trace IDs are 32 hex characters (128 bits)
    return this.traceIdCounter.toString(16).padStart(32, "0");
  }

  generateSpanId(): string {
    this.spanIdCounter++;
    // OTel span IDs are 16 hex characters (64 bits)
    return this.spanIdCounter.toString(16).padStart(16, "0");
  }
}

/**
 * Span context in dictionary format for snapshot comparison
 */
export interface SpanContext {
  trace_id: string;
  span_id: string;
  is_remote: boolean;
}

/**
 * Span in dictionary format for snapshot comparison.
 */
export interface SpanDict {
  name: string;
  context: SpanContext;
  parent: SpanContext | null;
  start_time: [number, number];
  end_time: [number, number];
  attributes: Record<string, unknown>;
  events?: Array<{ name: string; timestamp: [number, number] }>;
}

/**
 * Convert ReadableSpan objects to dictionaries for snapshot testing.
 * Internal function used by TestSpanExporter.
 */
function spansToDict(spans: ReadableSpan[]): SpanDict[] {
  return spans.map((span) => {
    const result: SpanDict = {
      name: span.name,
      context: {
        trace_id: span.spanContext().traceId,
        span_id: span.spanContext().spanId,
        is_remote: span.spanContext().isRemote ?? false,
      },
      parent: span.parentSpanContext
        ? {
            trace_id: span.parentSpanContext.traceId,
            span_id: span.parentSpanContext.spanId,
            is_remote: span.parentSpanContext.isRemote ?? false,
          }
        : null,
      start_time: span.startTime as [number, number],
      end_time: span.endTime as [number, number],
      attributes: { ...span.attributes },
    };

    // Include events if present
    if (span.events && span.events.length > 0) {
      result.events = span.events.map((e) => ({
        name: e.name,
        timestamp: e.time as [number, number],
      }));
    }

    return result;
  });
}

/**
 * Sort spans by their span_id for consistent ordering in snapshots.
 * Useful when span order is non-deterministic.
 */
export function sortSpansBySpanId(spans: SpanDict[]): SpanDict[] {
  return [...spans].sort((a, b) =>
    a.context.span_id.localeCompare(b.context.span_id),
  );
}

/**
 * Simplified span format for inline snapshots.
 * Use with Vitest property matchers for dynamic values.
 */
export interface SimplifiedSpan {
  name: string;
  trace_id: string;
  span_id: string;
  attributes: Record<string, unknown>;
}

export interface SimplifyOptions {
  /**
   * When true, replaces dynamic values with placeholders:
   * - gen_ai.conversation.id → "<conversation_id>"
   * - gen_ai.response.id → "<response_id>"
   * - gen_ai.usage.input_tokens → "<input_tokens>"
   * - gen_ai.usage.output_tokens → "<output_tokens>"
   * - gen_ai.output.messages → "<output_messages>"
   * - openai_agents.span_data → "<span_data>"
   * - input.value → "<input_value>"
   * - output.value → stripped (flaky, depends on instrumentation timing)
   * - metadata → "<metadata>"
   *
   * When false (default), preserves original values for use with
   * Vitest property matchers like expect.any(Number).
   */
  normalize?: boolean;
}

/**
 * Simplify spans for inline snapshot testing.
 * Strips timing info, optionally normalizes dynamic values to placeholders.
 */
export function simplifySpansForSnapshot(
  spans: SpanDict[],
  options: SimplifyOptions = {},
): SimplifiedSpan[] {
  const { normalize = false } = options;

  return spans.map((span) => {
    const attributes: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(span.attributes)) {
      // Skip undefined values — they're non-deterministic from instrumentation
      if (value === undefined) continue;
      if (normalize) {
        // Normalize dynamic values to placeholders
        if (key === "gen_ai.conversation.id") {
          attributes[key] = "<conversation_id>";
        } else if (key === "gen_ai.response.id") {
          attributes[key] = "<response_id>";
        } else if (key === "gen_ai.usage.input_tokens") {
          attributes[key] = "<input_tokens>";
        } else if (key === "gen_ai.usage.output_tokens") {
          attributes[key] = "<output_tokens>";
        } else if (key === "gen_ai.output.messages") {
          attributes[key] = "<output_messages>";
        } else if (key === "openai_agents.span_data") {
          attributes[key] = "<span_data>";
        } else if (key === "input.value") {
          attributes[key] = "<input_value>";
        } else if (key === "output.value") {
          // Strip — flaky, depends on instrumentation timing
          continue;
        } else if (key === "metadata") {
          attributes[key] = "<metadata>";
        } else if (key === "ai.response.text") {
          attributes[key] = "<response_text>";
        } else if (key === "ai.response.id") {
          attributes[key] = "<response_id>";
        } else if (key === "ai.response.model") {
          attributes[key] = "<response_model>";
        } else if (key === "ai.response.providerMetadata") {
          attributes[key] = "<provider_metadata>";
        } else if (key === "ai.response.timestamp") {
          attributes[key] = "<timestamp>";
        } else if (key === "ai.usage.promptTokens") {
          attributes[key] = "<input_tokens>";
        } else if (key === "ai.usage.completionTokens") {
          attributes[key] = "<output_tokens>";
        } else if (key === "llm.token_count.prompt") {
          attributes[key] = "<input_tokens>";
        } else if (key === "llm.token_count.completion") {
          attributes[key] = "<output_tokens>";
        } else if (key === "gen_ai.response.model") {
          attributes[key] = "<response_model>";
        } else {
          attributes[key] = value;
        }
      } else {
        attributes[key] = value;
      }
    }

    return {
      name: span.name,
      trace_id: span.context.trace_id,
      span_id: span.context.span_id,
      attributes,
    };
  });
}

/**
 * Parse and validate a JSON string attribute.
 * Throws if the value is not a valid JSON string.
 * Use this instead of comparing raw JSON strings in tests.
 */
export function parseJsonAttr(value: unknown): unknown {
  if (typeof value !== "string") {
    throw new Error(`Expected string attribute, got ${typeof value}`);
  }
  return JSON.parse(value);
}

/**
 * SpanExporter that captures spans and returns SpanDict[] for snapshot testing.
 * Implements SpanExporter protocol so it can be passed directly to AdvancedOptions.
 */
export class TestSpanExporter implements SpanExporter {
  private _exporter: InMemorySpanExporter;

  constructor() {
    this._exporter = new InMemorySpanExporter();
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    this._exporter.export(spans, resultCallback);
  }

  shutdown(): Promise<void> {
    return this._exporter.shutdown();
  }

  forceFlush(): Promise<void> {
    return this._exporter.forceFlush();
  }

  reset(): void {
    this._exporter.reset();
  }

  /** Return finished spans as SpanDict[] for snapshot testing. */
  getFinishedSpans(): SpanDict[] {
    return spansToDict(this._exporter.getFinishedSpans());
  }
}
