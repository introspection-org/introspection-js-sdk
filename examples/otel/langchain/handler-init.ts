/**
 * LangChain + `introspection.init()` one-liner.
 *
 * LangChain is traced through a per-invoke callback handler rather than a global
 * OTel provider. `init()` discovers `@langchain/core` and binds a handler;
 * retrieve it with `introspection.getLangchainHandler()` and pass it in
 * `callbacks` — the equivalent of Python's `langchain.get_handler()`.
 *
 * Run with: pnpm langchain-handler-init
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY    - Anthropic API key
 *   INTROSPECTION_TOKEN  - Introspection API token
 */

import * as introspection from "@introspection-sdk/introspection-node/otel";
import { ChatAnthropic } from "@langchain/anthropic";
import { tool } from "@langchain/core/tools";
import { HumanMessage } from "@langchain/core/messages";
import { z } from "zod";

async function main() {
  await introspection.init({ serviceName: "langchain-handler-init" });
  const handler = introspection.getLangchainHandler();

  const getWeather = tool(
    async ({ city }: { city: string }) =>
      `The weather in ${city} is sunny, 22°C`,
    {
      name: "get_weather",
      description: "Get the current weather for a city",
      schema: z.object({ city: z.string() }),
    },
  );

  const model = new ChatAnthropic({ model: "claude-haiku-4-5" }).bindTools([
    getWeather,
  ]);

  // Pass the handler per-invoke; every LLM/tool span lands in Introspection.
  const response = await model.invoke([new HumanMessage("Weather in Tokyo?")], {
    callbacks: [handler],
  });
  console.log("Response:", JSON.stringify(response.content));

  await introspection.shutdown();
  console.log("✓ Exported to Introspection.");
}

main().catch(console.error);
