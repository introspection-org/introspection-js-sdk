/**
 * Test fixtures for tracing processor tests.
 * Ported from Python introspection-stream-server/tests/conftest.py
 */

import {
  IntrospectionTracingProcessor,
  type TracingProcessorAdvancedOptions,
} from "@introspection-sdk/introspection-node";
import { IncrementalIdGenerator, TestSpanExporter } from "./testing";

/**
 * Capture fixture that bundles the exporter and processor together.
 */
export interface CaptureTracingProcessor {
  /** In-memory exporter that captures spans for assertions */
  exporter: TestSpanExporter;
  /** The tracing processor being tested */
  processor: IntrospectionTracingProcessor;
}

/**
 * Create a CaptureTracingProcessor fixture for testing.
 *
 * Uses:
 * - InMemorySpanExporter to capture spans without HTTP calls
 * - IncrementalIdGenerator for deterministic trace/span IDs
 * - SimpleSpanProcessor for immediate span processing (no batching delay)
 *
 * @example
 * ```typescript
 * const capture = createCaptureTracingProcessor();
 * addTraceProcessor(capture.processor);
 *
 * // Run agent...
 *
 * await capture.processor.forceFlush();
 * const spans = capture.exporter.getFinishedSpans();
 * ```
 */
export function createCaptureTracingProcessor(): CaptureTracingProcessor {
  const exporter = new TestSpanExporter();
  const idGenerator = new IncrementalIdGenerator();

  const advanced: TracingProcessorAdvancedOptions = {
    spanExporter: exporter,
    idGenerator,
    useSimpleSpanProcessor: true,
  };

  const processor = new IntrospectionTracingProcessor({
    advanced,
  });

  return { exporter, processor };
}
