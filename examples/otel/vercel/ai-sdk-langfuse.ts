/**
 * Vercel AI SDK + Langfuse dual export — the explicit, bring-your-own-provider
 * form.
 *
 * This is the most explicit dual-export shape: you construct the OTel
 * `NodeTracerProvider` yourself and lay out its span processors by hand — the
 * Introspection processor next to the Langfuse one — then register it as the
 * global provider. A single set of AI SDK spans then fans out to both backends.
 *
 * Because OpenTelemetry JS v2 fixes a provider's processors at construction
 * time, the dual-export wiring lives in the `new NodeTracerProvider({ ... })`
 * call rather than a later `addSpanProcessor`. `introspection.init({
 * tracerProvider })` then adopts the provider you built (it does not create its
 * own) and adds the baggage propagator, framework auto-discovery, and the
 * analytics/logs stream on top.
 *
 * The IntrospectionSpanProcessor forwards its own converted copy to
 * Introspection; the Langfuse processor receives the raw span — they run
 * independently, so processor order is irrelevant.
 *
 * Run with: pnpm ai-sdk-langfuse
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY     - Anthropic API key
 *   INTROSPECTION_TOKEN   - Introspection API token
 *   LANGFUSE_PUBLIC_KEY   - Langfuse public key
 *   LANGFUSE_SECRET_KEY   - Langfuse secret key
 */

import * as introspection from "@introspection-sdk/introspection-node/otel";
import { IntrospectionSpanProcessor } from "@introspection-sdk/introspection-node/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { generateText, stepCountIs, tool } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

import { langfuseSpanProcessor } from "../../_shared/dual-export";

const getWeather = tool({
  description: "Get current weather conditions for a city.",
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ city }) => `${city}: Sunny, 22°C, humidity 55%.`,
});

async function main() {
  // You own the provider and its processor list — Introspection alongside
  // Langfuse. Every span the AI SDK produces is handed to both.
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "vercel-ai-sdk-langfuse",
    }),
    spanProcessors: [
      new IntrospectionSpanProcessor({
        token: process.env.INTROSPECTION_TOKEN,
      }),
      langfuseSpanProcessor(),
    ],
  });
  provider.register();

  // Adopt the provider you built: adds the baggage propagator, framework
  // auto-discovery, and the analytics/logs stream — without creating a second
  // provider or processor.
  await introspection.init({ tracerProvider: provider });

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
  console.log("✓ Exported to Introspection + Langfuse.");
}

main().catch(console.error);
