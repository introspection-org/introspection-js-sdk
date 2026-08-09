/**
 * Shared fixtures for the recorded Pi Agent tests.
 *
 * Every consumer drives a **real** `pi-agent-core` Agent against a Polly HAR
 * of the Anthropic response, per the recording policy in `tests/README.md`.
 * Nothing here mocks pi itself: the only stand-ins are the OTel collectors
 * (an in-memory span exporter and a recording meter), which are the
 * observation surface, not the system under test.
 */

import type { Meter } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { Agent, AgentTool } from "@earendil-works/pi-agent-core";

import { IntrospectionSpanProcessor } from "@introspection-sdk/introspection-node/otel";
import { IncrementalIdGenerator } from "../testing";
import { pollyEndpoints } from "../polly-setup";

/** Cheapest model that still exercises tool calling end to end. */
export const MODEL_KEY = "claude-haiku-4-5";

/**
 * Builtin Anthropic model with the base URL pinned to the canonical Polly
 * endpoint, so the recorded request URL is identical whatever
 * `ANTHROPIC_BASE_URL` happens to be in the host shell.
 */
export async function makeModel() {
  const { getBuiltinModel } =
    await import("@earendil-works/pi-ai/providers/all");
  return {
    ...getBuiltinModel("anthropic", MODEL_KEY),
    baseUrl: pollyEndpoints.anthropic.node,
  };
}

export interface WeatherTool {
  tool: AgentTool;
  /** Cities the model actually asked about, in call order. */
  calls: string[];
}

/**
 * A small deterministic tool. Deterministic matters twice over: the recorded
 * turn-2 request body embeds the tool result, and Polly matches on body.
 */
export async function makeWeatherTool(): Promise<WeatherTool> {
  const { Type } = await import("@earendil-works/pi-ai");
  const calls: string[] = [];
  const data: Record<string, string> = {
    Tokyo: "Clear, 25°C",
    Paris: "Rainy, 12°C",
  };

  const tool: AgentTool = {
    name: "get_weather",
    label: "Get weather",
    description:
      "Get the current weather for a city. Returns conditions and temperature in Celsius.",
    parameters: Type.Object({ city: Type.String() }),
    execute: async (_id, params) => {
      const city = (params as { city: string }).city;
      calls.push(city);
      const result = data[city] ?? `No data for ${city}`;
      return { content: [{ type: "text", text: result }], details: { result } };
    },
  };

  return { tool, calls };
}

export interface MakeAgentOptions {
  systemPrompt?: string;
  tools?: AgentTool[];
  /** Override the model — used by the error test to force a 404 from the API. */
  model?: Awaited<ReturnType<typeof makeModel>>;
}

/** A real `Agent` wired to the real Anthropic stream function. */
export async function makeAgent(opts: MakeAgentOptions = {}): Promise<Agent> {
  const { Agent } = await import("@earendil-works/pi-agent-core");
  const { streamSimple } = await import("@earendil-works/pi-ai/compat");
  return new Agent({
    streamFn: streamSimple,
    initialState: {
      model: opts.model ?? (await makeModel()),
      systemPrompt: opts.systemPrompt ?? "Answer in one short sentence.",
      tools: opts.tools ?? [],
    },
  });
}

export interface PiTracing {
  exporter: InMemorySpanExporter;
  provider: NodeTracerProvider;
  spans: () => ReadableSpan[];
  /** Finished spans whose `gen_ai.operation.name` matches. */
  spansFor: (operation: string) => ReadableSpan[];
}

/**
 * The shipped export path: a `NodeTracerProvider` fed by the real
 * `IntrospectionSpanProcessor`, terminating in an in-memory exporter so the
 * test can read exactly what would have gone over the wire.
 */
export function piTracing(): PiTracing {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    idGenerator: new IncrementalIdGenerator(),
    spanProcessors: [
      new IntrospectionSpanProcessor({
        token: "test-token",
        advanced: { spanExporter: exporter, useSimpleSpanProcessor: true },
      }),
    ],
  });
  provider.register();

  const spans = () => exporter.getFinishedSpans();
  return {
    exporter,
    provider,
    spans,
    spansFor: (operation) =>
      spans().filter(
        (s) => s.attributes["gen_ai.operation.name"] === operation,
      ),
  };
}

export interface MetricRecord {
  value: number;
  attributes?: Record<string, unknown>;
}

/**
 * Minimal `Meter` that keeps every recorded measurement in memory.
 *
 * `@opentelemetry/sdk-metrics` is deliberately not a dependency of this
 * workspace; the histogram contract we need to observe is one method wide.
 */
export function recordingMeter(): {
  meter: Meter;
  records: Record<string, MetricRecord[]>;
} {
  const records: Record<string, MetricRecord[]> = {};
  const meter = {
    createHistogram(name: string) {
      records[name] ??= [];
      return {
        record(value: number, attributes?: Record<string, unknown>) {
          records[name]?.push({ value, attributes });
        },
      };
    },
  } as unknown as Meter;
  return { meter, records };
}

/** Parse a JSON-serialized span attribute. */
export function jsonAttr<T = unknown>(span: ReadableSpan, key: string): T {
  const raw = span.attributes[key];
  if (typeof raw !== "string") {
    throw new Error(`Expected ${key} to be a JSON string, got ${typeof raw}`);
  }
  return JSON.parse(raw) as T;
}
