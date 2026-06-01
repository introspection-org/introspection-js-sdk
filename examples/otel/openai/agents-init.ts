/**
 * OpenAI Agents SDK + `introspection.init()` one-liner.
 *
 * The OpenAI Agents SDK has its own tracing system. `init()` discovers
 * `@openai/agents` and registers the IntrospectionTracingProcessor with it
 * (`addTraceProcessor`) for you — so a single `init()` call is all the wiring
 * needed. Contrast with `agents.ts`, which adds the processor by hand.
 *
 * Run with: pnpm openai-agents-init
 *
 * Required env vars:
 *   OPENAI_API_KEY       - OpenAI API key
 *   INTROSPECTION_TOKEN  - Introspection API token
 */

import { Agent, run, tool } from "@openai/agents";
import * as introspection from "@introspection-sdk/introspection-node/otel";
import { z } from "zod";

const getWeather = tool({
  name: "get_weather",
  description: "Get the current weather for a city",
  parameters: z.object({ city: z.string() }),
  strict: true,
  execute: async ({ city }) => `The weather in ${city} is sunny, 22°C`,
});

async function main() {
  // One call: discovers @openai/agents and registers the tracing processor.
  await introspection.init({ serviceName: "openai-agents-init" });

  const agent = new Agent({
    name: "Weather Assistant",
    model: "gpt-5-nano",
    instructions: "You are a helpful weather assistant.",
    tools: [getWeather],
  });

  const result = await run(agent, "What's the weather in Tokyo?");
  console.log("Result:", result.finalOutput);

  await introspection.shutdown();
  console.log("✓ Exported to Introspection.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
