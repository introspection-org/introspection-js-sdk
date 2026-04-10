/**
 * Mastra AI SDK + Arize + Introspection Example
 *
 * Dual exports Mastra agent traces to Arize and the Introspection backend.
 * Arize needs OpenInference conventions, so we wrap the OTLP exporter with
 * a mapper that translates gen_ai.* attributes to OpenInference format.
 *
 * Run with: pnpm mastra-arize
 */

import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { openai } from "@ai-sdk/openai";
import { Observability } from "@mastra/observability";
import { OtelExporter } from "@mastra/otel-exporter";
import { IntrospectionMastraExporter } from "@introspection-sdk/introspection-node/mastra";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { z } from "zod";
import { OpenInferenceSpanExporter } from "@introspection-sdk/introspection-node";

if (!process.env.ARIZE_SPACE_KEY || !process.env.ARIZE_API_KEY) {
  throw new Error("ARIZE_SPACE_KEY and ARIZE_API_KEY must be set");
}
if (!process.env.INTROSPECTION_TOKEN) {
  throw new Error("INTROSPECTION_TOKEN must be set");
}

const arizeOtlp = new OTLPTraceExporter({
  url: "https://otlp.arize.com/v1/traces",
  headers: {
    space_id: process.env.ARIZE_SPACE_KEY,
    api_key: process.env.ARIZE_API_KEY,
  },
});

const arizeExporter = new OtelExporter({
  provider: {
    custom: {
      endpoint: "https://otlp.arize.com/v1/traces",
      protocol: "http/protobuf",
      headers: {
        space_id: process.env.ARIZE_SPACE_KEY,
        api_key: process.env.ARIZE_API_KEY,
      },
    },
  },
  exporter: new OpenInferenceSpanExporter(arizeOtlp),
  resourceAttributes: {
    "openinference.project.name": "mastra-arize-introspection-demo",
  },
});

const baseUrl =
  process.env.INTROSPECTION_BASE_URL || "https://otel.introspection.dev";

const introspectionExporter = new IntrospectionMastraExporter();

const observability = new Observability({
  configs: {
    arize: {
      serviceName: "mastra-arize-introspection-demo",
      exporters: [arizeExporter, introspectionExporter],
    },
  },
});

const mastra = new Mastra({
  observability,
});

const getWeatherTool = {
  name: "get_weather",
  description: "Get the current weather for a city",
  parameters: z.object({
    city: z.string().describe("The city name"),
  }),
  execute: async ({ city }: { city: string }) => {
    return `The weather in ${city} is sunny, 72°F`;
  },
};

const agent = new Agent({
  id: "assistant",
  name: "assistant",
  instructions: "You are a helpful weather assistant.",
  model: openai("gpt-4o-mini"),
  tools: {
    get_weather: getWeatherTool,
  },
  mastra,
});

async function main() {
  console.log("Exporting traces to Arize + Introspection");

  const response = await agent.generate("What's the weather in Tokyo?");
  console.log("Response:", response.text);

  await observability.shutdown();
}

main().catch(console.error);
