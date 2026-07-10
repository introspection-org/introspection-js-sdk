/**
 * GenAI client metric instruments per the OTel GenAI semconv metrics doc.
 *
 * Instruments are created lazily per `Meter` and cached, so repeated
 * `instrumentStream` / `instrumentAgent` calls sharing a meter reuse the
 * same histograms. Bucket boundaries follow the spec's
 * ExplicitBucketBoundaries advice where one is defined.
 */

import type { Histogram, Meter } from "@opentelemetry/api";

/** Spec advice for `gen_ai.client.token.usage`. */
const TOKEN_BUCKETS = [
  1, 4, 16, 64, 256, 1024, 4096, 16384, 65536, 262144, 1048576, 4194304,
  16777216, 67108864,
];

/** Spec advice for the client duration / chunk-timing histograms. */
const DURATION_BUCKETS = [
  0.01, 0.02, 0.04, 0.08, 0.16, 0.32, 0.64, 1.28, 2.56, 5.12, 10.24, 20.48,
  40.96, 81.92,
];

/** Spec advice for in-process agent invocation durations. */
const AGENT_DURATION_BUCKETS = [
  0.1, 0.2, 0.4, 0.8, 1.6, 3.2, 6.4, 12.8, 25.6, 51.2, 102.4, 204.8, 409.6,
];

export interface GenAiMetrics {
  /** `gen_ai.client.token.usage` — record once per token type per call. */
  tokenUsage: Histogram;
  /** `gen_ai.client.operation.duration` — seconds per chat call. */
  operationDuration: Histogram;
  /** `gen_ai.client.operation.time_to_first_chunk` — streaming only. */
  timeToFirstChunk: Histogram;
  /** `gen_ai.client.operation.time_per_output_chunk` — per chunk after the first. */
  timePerOutputChunk: Histogram;
  /** `gen_ai.execute_tool.duration` — seconds per tool execution. */
  executeToolDuration: Histogram;
  /** `gen_ai.invoke_agent.duration` — seconds per in-process agent run. */
  invokeAgentDuration: Histogram;
}

const metricsByMeter = new WeakMap<Meter, GenAiMetrics>();

/** Get (or create) the GenAI instruments for a meter. */
export function genAiMetrics(meter: Meter): GenAiMetrics {
  const cached = metricsByMeter.get(meter);
  if (cached) return cached;

  const metrics: GenAiMetrics = {
    tokenUsage: meter.createHistogram("gen_ai.client.token.usage", {
      description: "Number of input and output tokens used.",
      unit: "{token}",
      advice: { explicitBucketBoundaries: TOKEN_BUCKETS },
    }),
    operationDuration: meter.createHistogram(
      "gen_ai.client.operation.duration",
      {
        description: "GenAI operation duration.",
        unit: "s",
        advice: { explicitBucketBoundaries: DURATION_BUCKETS },
      },
    ),
    timeToFirstChunk: meter.createHistogram(
      "gen_ai.client.operation.time_to_first_chunk",
      {
        description:
          "Time to receive the first chunk of the response stream, measured from request issuance.",
        unit: "s",
        advice: { explicitBucketBoundaries: DURATION_BUCKETS },
      },
    ),
    timePerOutputChunk: meter.createHistogram(
      "gen_ai.client.operation.time_per_output_chunk",
      {
        description:
          "Time per output chunk, recorded for each chunk received after the first one.",
        unit: "s",
        advice: { explicitBucketBoundaries: DURATION_BUCKETS },
      },
    ),
    executeToolDuration: meter.createHistogram("gen_ai.execute_tool.duration", {
      description: "The duration of a single tool execution.",
      unit: "s",
      advice: { explicitBucketBoundaries: DURATION_BUCKETS },
    }),
    invokeAgentDuration: meter.createHistogram("gen_ai.invoke_agent.duration", {
      description:
        "The end-to-end duration of a single in-process agent invocation.",
      unit: "s",
      advice: { explicitBucketBoundaries: AGENT_DURATION_BUCKETS },
    }),
  };

  metricsByMeter.set(meter, metrics);
  return metrics;
}
