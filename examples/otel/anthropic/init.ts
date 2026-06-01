/**
 * Anthropic one-liner example: `introspection.init()` auto-detects Anthropic.
 *
 * A single `introspection.init()` call detects the installed `@anthropic-ai/sdk`,
 * patches it (capturing extended-thinking blocks + signatures), and wires it
 * into Introspection's trace pipeline — no manual TracerProvider or instrumentor.
 * Contrast with `anthropic-native.ts`, which shows the explicit standalone path.
 *
 * Two equivalent import styles (pick one):
 *
 *   // 1. One-liner namespace import
 *   import * as introspection from "@introspection-sdk/introspection-node/otel";
 *   await introspection.init();
 *
 *   // 2. Named ("dual") import — same surface, granular
 *   import { init, conversation } from "@introspection-sdk/introspection-node/otel";
 *   await init();
 *
 * Run with:
 *   export INTROSPECTION_TOKEN=...
 *   export ANTHROPIC_API_KEY=...
 *   pnpm anthropic-init
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ThinkingConfigEnabled,
  Tool,
} from "@anthropic-ai/sdk/resources/messages";
import * as introspection from "@introspection-sdk/introspection-node/otel";

function getWeather(city: string): string {
  const data: Record<string, string> = {
    Tokyo: "Clear, 25°C",
    Paris: "Rainy, 12°C",
  };
  return data[city] || `No data for ${city}`;
}

async function main() {
  // One line: detects anthropic (and any other installed frameworks) and wires
  // them into the shared trace pipeline.
  await introspection.init({ serviceName: "anthropic-init-example" });

  // Constructed AFTER init() — auto-traced, no per-client wiring.
  const client = new Anthropic();
  const tools: Tool[] = [
    {
      name: "get_weather",
      description:
        "Get weather for a city. Returns conditions and temperature in Celsius.",
      input_schema: {
        type: "object" as const,
        properties: { city: { type: "string", description: "City name" } },
        required: ["city"],
      },
    },
  ];

  const model = "claude-sonnet-4-6";
  const thinking: ThinkingConfigEnabled = {
    type: "enabled",
    budget_tokens: 5000,
  };
  const messages: MessageParam[] = [
    { role: "user", content: "What's the weather in Tokyo?" },
  ];

  // `conversation()` scopes every span produced inside to one conversation id.
  await introspection.conversation(async () => {
    console.log("=== Turn 1: Thinking + Tool Call ===");
    const res1 = await client.messages.create({
      model,
      max_tokens: 8000,
      thinking,
      tools,
      messages,
    });
    messages.push({ role: "assistant", content: res1.content });

    const toolUse = res1.content.find((b) => b.type === "tool_use");
    if (toolUse && toolUse.type === "tool_use") {
      const result = getWeather(
        (toolUse.input as { city?: string }).city ?? "",
      );
      console.log(`  [Tool] ${toolUse.name} -> ${result}`);
      messages.push({
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: toolUse.id, content: result },
        ],
      });

      console.log("=== Turn 2: Tool Result -> Summary ===");
      const res2 = await client.messages.create({
        model,
        max_tokens: 8000,
        thinking,
        tools,
        messages,
      });
      for (const block of res2.content) {
        if (block.type === "text") console.log(`  [Response] ${block.text}`);
      }
    }
  });

  await introspection.shutdown();
  console.log("\n✓ All turns completed. Thinking blocks captured in traces.");
}

main().catch(console.error);
