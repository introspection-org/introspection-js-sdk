/**
 * OpenAI Agents SDK Example
 *
 * Demonstrates using IntrospectionTracingProcessor with the OpenAI Agents SDK.
 * This uses native TracingProcessor integration (not OpenInference).
 *
 * Run with: pnpm openai-agents
 */

import { Agent, run, addTraceProcessor, tool } from "@openai/agents";
import { IntrospectionTracingProcessor } from "@introspection-sdk/introspection-node";
import { z } from "zod";

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
    serviceName: "openai-agents-example",
  });
  addTraceProcessor(processor);

  const agent = new Agent({
    name: "Weather Assistant",
    model: "gpt-5-nano",
    instructions: "You are a helpful weather assistant.",
    tools: [getWeather],
  });

  const result = await run(agent, "What's the weather in Tokyo?");
  console.log("Result:", result.finalOutput);

  await processor.shutdown();
}

main().catch(console.error);
