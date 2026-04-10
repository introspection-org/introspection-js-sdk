/**
 * Mastra AI SDK + Langfuse + Introspection Example
 *
 * Demonstrates dual exporting Mastra agent traces to both:
 * - Langfuse (via OtelExporter with Langfuse OTLP endpoint and Basic auth)
 * - Introspection backend (via OtelExporter)
 *
 * Requires: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, INTROSPECTION_TOKEN, OPENAI_API_KEY
 *
 * Run with: pnpm mastra-langfuse
 */

import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { openai } from "@ai-sdk/openai";
import { Observability } from "@mastra/observability";
import { OtelExporter } from "@mastra/otel-exporter";
import { IntrospectionMastraExporter } from "@introspection-sdk/introspection-node/mastra";
import { z } from "zod";

if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
  throw new Error("LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set");
}
if (!process.env.INTROSPECTION_TOKEN) {
  throw new Error("INTROSPECTION_TOKEN must be set");
}

// --- Langfuse exporter (Basic auth) ---
const langfuseAuth = Buffer.from(
  `${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`,
).toString("base64");
const langfuseBaseUrl =
  process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com";

const langfuseExporter = new OtelExporter({
  provider: {
    custom: {
      endpoint: `${langfuseBaseUrl}/api/public/otel/v1/traces`,
      protocol: "http/protobuf",
      headers: {
        Authorization: `Basic ${langfuseAuth}`,
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
    langfuse: {
      serviceName: "mastra-langfuse-introspection-demo",
      exporters: [langfuseExporter, introspectionExporter],
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
  console.log("Exporting traces to Langfuse + Introspection");

  const response = await agent.generate("What's the weather in Tokyo?");
  console.log("Response:", response.text);

  await observability.shutdown();
}

main().catch(console.error);
