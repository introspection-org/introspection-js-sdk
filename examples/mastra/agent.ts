/**
 * Mastra AI SDK Example
 *
 * Demonstrates using IntrospectionMastraExporter — a first-party Mastra
 * exporter that converts Mastra spans to gen_ai.* semantic conventions
 * for the Introspection backend.
 *
 * Run with: pnpm mastra-ai
 */

import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { Observability } from "@mastra/observability";
import { IntrospectionMastraExporter } from "@introspection-sdk/introspection-node/mastra";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

const observability = new Observability({
  configs: {
    otel: {
      serviceName: "mastra-weather-assistant",
      exporters: [new IntrospectionMastraExporter()],
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
  console.log("Running Mastra agent with IntrospectionMastraExporter...");

  const result = await agent.generate("What's the weather in Tokyo?");
  console.log("Result:", result.text);

  await observability.shutdown();
  console.log("Done — spans exported to Introspection.");
}

main().catch(console.error);
