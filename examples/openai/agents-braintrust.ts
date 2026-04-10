/**
 * OpenAI Agents SDK + Braintrust + Introspection Example
 *
 * Demonstrates dual tracing with:
 * - Braintrust (via OTLP export to Braintrust's OTEL endpoint)
 * - Introspection (via IntrospectionTracingProcessor with CompositeSpanExporter)
 *
 * Uses a CompositeSpanExporter to send the same spans to both Braintrust and
 * Introspection simultaneously through the processor's internal TracerProvider.
 *
 * Requires: BRAINTRUST_API_KEY, INTROSPECTION_TOKEN, OPENAI_API_KEY
 *
 * Run with: pnpm openai-agents-braintrust
 */

import { Agent, run, addTraceProcessor, tool } from "@openai/agents";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import type { SpanExporter, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { IntrospectionTracingProcessor } from "@introspection-sdk/introspection-node";
import { z } from "zod";

if (!process.env.BRAINTRUST_API_KEY) {
  throw new Error("BRAINTRUST_API_KEY must be set");
}
if (!process.env.INTROSPECTION_TOKEN) {
  throw new Error("INTROSPECTION_TOKEN must be set");
}

// --- Composite exporter: sends spans to multiple destinations ---
const SUCCESS = 0;
const FAILED = 1;

class CompositeSpanExporter implements SpanExporter {
  constructor(private exporters: SpanExporter[]) {}

  export(
    spans: ReadableSpan[],
    resultCallback: (result: { code: number }) => void,
  ): void {
    let completed = 0;
    let hasError = false;
    for (const exporter of this.exporters) {
      exporter.export(spans, (result) => {
        if (result.code === FAILED) hasError = true;
        completed++;
        if (completed === this.exporters.length) {
          resultCallback({ code: hasError ? FAILED : SUCCESS });
        }
      });
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.exporters.map((e) => e.shutdown()));
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.exporters.map((e) => e.forceFlush?.()));
  }
}

// --- Braintrust exporter ---
const braintrustExporter = new OTLPTraceExporter({
  url: "https://api.braintrust.dev/otel/v1/traces",
  headers: {
    Authorization: `Bearer ${process.env.BRAINTRUST_API_KEY}`,
    "x-bt-parent": "project_name:openai-agents-braintrust-example",
  },
});

// --- Introspection exporter ---
const baseUrl =
  process.env.INTROSPECTION_BASE_URL || "https://otel.introspection.dev";
const introspectionEndpoint = `${baseUrl.replace(/\/$/, "")}/v1/traces`;

const introspectionExporter = new OTLPTraceExporter({
  url: introspectionEndpoint,
  headers: {
    Authorization: `Bearer ${process.env.INTROSPECTION_TOKEN}`,
  },
});

// --- Tool definition ---
const getWeather = tool({
  name: "get_weather",
  description: "Get the current weather for a city",
  parameters: z.object({
    city: z.string().describe("The city name"),
  }),
  strict: true,
  execute: async ({ city }) => {
    return `The weather in ${city} is sunny, 72°F`;
  },
});

async function main() {
  const processor = new IntrospectionTracingProcessor({
    serviceName: "openai-agents-braintrust",
    advanced: {
      spanExporter: new CompositeSpanExporter([
        braintrustExporter,
        introspectionExporter,
      ]),
    },
  });
  addTraceProcessor(processor);

  const agent = new Agent({
    name: "Weather Assistant",
    model: "gpt-5-nano",
    instructions: "You are a helpful weather assistant.",
    tools: [getWeather],
  });

  console.log("Exporting traces to Braintrust + Introspection\n");

  const result = await run(agent, "What's the weather in Tokyo?");
  console.log("Result:", result.finalOutput);

  await processor.forceFlush();
  await processor.shutdown();
}

main().catch(console.error);
