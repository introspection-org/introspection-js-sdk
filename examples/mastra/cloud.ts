/**
 * Mastra Cloud + Introspection Dual Export Example
 *
 * Demonstrates dual exporting Mastra agent traces to both:
 * - Mastra Cloud (via CloudExporter, requires MASTRA_CLOUD_ACCESS_TOKEN)
 * - Introspection backend (via OtelExporter)
 *
 * Requires: MASTRA_CLOUD_ACCESS_TOKEN, INTROSPECTION_TOKEN, OPENAI_API_KEY
 *
 * Run with: pnpm mastra-cloud
 *
 * @see https://mastra.ai/docs/observability/tracing/overview
 */

import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { Observability, CloudExporter } from "@mastra/observability";
import { OtelExporter } from "@mastra/otel-exporter";
import { IntrospectionMastraExporter } from "@introspection-sdk/introspection-node/mastra";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

if (!process.env.MASTRA_CLOUD_ACCESS_TOKEN) {
  throw new Error("MASTRA_CLOUD_ACCESS_TOKEN must be set");
}

// --- Mastra Cloud exporter ---
const cloudExporter = new CloudExporter();

// --- Introspection exporter ---
const baseUrl =
  process.env.INTROSPECTION_BASE_URL || "https://otel.introspection.dev";

const introspectionExporter = new IntrospectionMastraExporter();

// --- Mastra setup with dual export ---
const observability = new Observability({
  configs: {
    default: {
      serviceName: "mastra-cloud-example",
      exporters: [cloudExporter, introspectionExporter],
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
  id: "weather-assistant",
  name: "weather-assistant",
  instructions: "You are a helpful weather assistant.",
  model: openai("gpt-4o-mini"),
  tools: {
    get_weather: getWeatherTool,
  },
  mastra,
});

async function main() {
  console.log("Exporting traces to Mastra Cloud + Introspection");

  const result = await agent.generate("What's the weather in Tokyo?");
  console.log("Result:", result.text);

  await observability.shutdown();
}

main().catch(console.error);
