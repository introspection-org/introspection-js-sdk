/**
 * Mastra + `introspection.init()` one-liner.
 *
 * Mastra exports telemetry through its own `Observability` config rather than a
 * global OTel provider, so it can't be wired purely globally. `init()` discovers
 * `@mastra/core` and binds an exporter; you place it in the Observability config
 * via `introspection.getMastraExporter()` — the equivalent of Python's
 * `mastra.get_exporter()`.
 *
 * Run with: pnpm mastra-init
 *
 * Required env vars:
 *   OPENAI_API_KEY       - OpenAI API key
 *   INTROSPECTION_TOKEN  - Introspection API token
 */

import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { openai } from "@ai-sdk/openai";
import { Observability } from "@mastra/observability";
import * as introspection from "@introspection-sdk/introspection-node/otel";
import { z } from "zod";

async function main() {
  await introspection.init({ serviceName: "mastra-init-example" });

  const observability = new Observability({
    configs: {
      introspection: {
        serviceName: "mastra-init-example",
        exporters: [introspection.getMastraExporter()],
      },
    },
  });

  const mastra = new Mastra({ observability });

  const agent = new Agent({
    id: "assistant",
    name: "assistant",
    instructions: "You are a helpful weather assistant.",
    model: openai("gpt-4o-mini"),
    tools: {
      get_weather: {
        name: "get_weather",
        description: "Get the current weather for a city",
        parameters: z.object({ city: z.string() }),
        execute: async ({ city }: { city: string }) =>
          `The weather in ${city} is sunny, 22°C`,
      },
    },
    mastra,
  });

  const response = await agent.generate("What's the weather in Tokyo?");
  console.log("Response:", response.text);

  await observability.shutdown();
  await introspection.shutdown();
  console.log("✓ Exported to Introspection.");
}

main().catch(console.error);
