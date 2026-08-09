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
