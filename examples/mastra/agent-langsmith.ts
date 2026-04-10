/**
 * Mastra AI SDK + LangSmith + Introspection Example
 *
 * Demonstrates dual exporting Mastra agent traces to both:
 * - LangSmith (via OtelExporter with LangSmith OTLP endpoint)
 * - Introspection backend (via OtelExporter)
 *
 * Requires: LANGSMITH_API_KEY, INTROSPECTION_TOKEN, OPENAI_API_KEY
 *
 * Run with: pnpm mastra-langsmith
 */

import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { openai } from "@ai-sdk/openai";
import { Observability } from "@mastra/observability";
import { OtelExporter } from "@mastra/otel-exporter";
import { IntrospectionMastraExporter } from "@introspection-sdk/introspection-node/mastra";
import { z } from "zod";

if (!process.env.LANGSMITH_API_KEY) {
  throw new Error("LANGSMITH_API_KEY must be set");
}
if (!process.env.INTROSPECTION_TOKEN) {
  throw new Error("INTROSPECTION_TOKEN must be set");
}

// --- LangSmith exporter ---
const langsmithExporter = new OtelExporter({
  provider: {
    custom: {
      endpoint: "https://api.smith.langchain.com/otel/v1/traces",
      protocol: "http/protobuf",
      headers: {
        "x-api-key": process.env.LANGSMITH_API_KEY,
      },
    },
  },
});

// --- Introspection exporter ---
const baseUrl =
  process.env.INTROSPECTION_BASE_URL || "https://otel.introspection.dev";

const introspectionExporter = new IntrospectionMastraExporter();

// --- Mastra setup with dual export ---
const observability = new Observability({
  configs: {
    langsmith: {
      serviceName: "mastra-langsmith-introspection-demo",
      exporters: [langsmithExporter, introspectionExporter],
    },
  },
});

const mastra = new Mastra({
  observability,
});

// Define a tool
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

// Create a Mastra agent
const agent = new Agent({
  id: "assistant",
  name: "assistant",
  instructions: "You are a helpful weather assistant.",
  model: openai("gpt-4o-mini"),
  tools: {
    get_weather: getWeatherTool,
  },
  mastra, // Connect agent to Mastra instance for observability
});

async function main() {
  console.log("Exporting traces to LangSmith + Introspection");

  const response = await agent.generate("What's the weather in Tokyo?");
  console.log("Response:", response.text);

  await observability.shutdown();
}

main().catch(console.error);
