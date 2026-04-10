/**
 * AI SDK First-Party Integration Example
 *
 * Demonstrates using IntrospectionAISDKIntegration — the first-party
 * TelemetryIntegration for the Vercel AI SDK. No OpenInference or
 * TracerProvider setup needed.
 *
 * Run with: pnpm ai-sdk
 */

import { IntrospectionAISDKIntegration } from "@introspection-sdk/introspection-node";
import { generateText } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { randomUUID } from "crypto";

async function main() {
  const introspection = new IntrospectionAISDKIntegration({
    serviceName: "ai-sdk-example",
  });

  const conversationId = randomUUID();

  console.log("Running generateText with system prompt...");
  console.log("Conversation ID:", conversationId);

  const { text } = await generateText({
    model: anthropic("claude-sonnet-4-20250514"),
    system:
      "You are a concise weather assistant. Provide brief, realistic weather forecasts with temperature, conditions, and a one-line tip. Keep responses under 50 words.",
    prompt: "What is the weather in Boston and Tokyo today?",
    experimental_telemetry: {
      isEnabled: true,
      functionId: "weather-agent",
      metadata: {
        "gen_ai.conversation.id": conversationId,
      },
      integrations: [introspection],
    },
  });

  console.log("Response:", text);

  await introspection.shutdown();
  console.log("Done — spans exported to Introspection.");
}

main().catch(console.error);
