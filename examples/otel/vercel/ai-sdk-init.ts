/**
 * Vercel AI SDK + `introspection.init()` one-liner.
 *
 * The AI SDK emits OpenTelemetry spans natively when
 * `experimental_telemetry: { isEnabled: true }` is set. `introspection.init()`
 * registers the global TracerProvider (with the IntrospectionSpanProcessor) plus
 * the W3C baggage propagator, so those native spans flow to Introspection with
 * no per-call wiring — and `conversation()` stamps `gen_ai.conversation.id` onto
 * every span produced inside its scope.
 *
 * Run with: pnpm ai-sdk-init
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY    - Anthropic API key
 *   INTROSPECTION_TOKEN  - Introspection API token
 */

import * as introspection from "@introspection-sdk/introspection-node/otel";
import { generateText, stepCountIs, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

const getWeather = tool({
  description: "Get current weather conditions for a city.",
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }) => `${city}: Sunny, 22°C, humidity 55%.`,
});

async function main() {
  // One call: registers the global provider + baggage propagator and wires the
  // installed frameworks. The AI SDK's native telemetry uses this provider.
  await introspection.init({ serviceName: "vercel-ai-sdk-init" });

  await introspection.conversation(async () => {
    const { text } = await generateText({
      model: anthropic("claude-haiku-4-5"),
      prompt: "What is the weather in Tokyo? Use the tool.",
      tools: { getWeather },
      stopWhen: stepCountIs(3),
      experimental_telemetry: { isEnabled: true, functionId: "weather-agent" },
    });
    console.log(text);
  });

  await introspection.shutdown();
  console.log("✓ Exported to Introspection.");
}

main().catch(console.error);
