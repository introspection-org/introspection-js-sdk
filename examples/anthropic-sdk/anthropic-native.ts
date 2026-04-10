/**
 * Anthropic Native Instrumentation Example
 *
 * Uses Introspection's AnthropicInstrumentor to capture the full Anthropic response
 * including thinking blocks (extended thinking) with signatures. Demonstrates
 * multi-turn conversation where thinking blocks are replayed in the history
 * and the model reasons over previous outputs.
 *
 * Run with: pnpm anthropic-native
 */

import Anthropic from "@anthropic-ai/sdk";
import type {
  MessageParam,
  ToolParam,
  ThinkingConfigEnabledParam,
} from "@anthropic-ai/sdk/resources/messages";
import {
  AnthropicInstrumentor,
  IntrospectionSpanProcessor,
} from "@introspection-sdk/introspection-node";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

function getWeather(city: string): string {
  const data: Record<string, string> = {
    Tokyo: "Clear, 25°C",
    Paris: "Rainy, 12°C",
  };
  return data[city] || `No data for ${city}`;
}

async function main() {
  const processor = new IntrospectionSpanProcessor({
    serviceName: "anthropic-native-example",
  });
  const provider = new NodeTracerProvider({
    spanProcessors: [processor],
  });
  provider.register();

  const client = new Anthropic();
  const instrumentor = new AnthropicInstrumentor();
  instrumentor.instrument({ tracerProvider: provider, client });
  const tools: ToolParam[] = [
    {
      name: "get_weather",
      description:
        "Get weather for a city. Returns conditions and temperature in Celsius.",
      input_schema: {
        type: "object" as const,
        properties: {
          city: { type: "string", description: "City name" },
        },
        required: ["city"],
      },
    },
  ];

  const model = "claude-sonnet-4-5-20250929";
  const system =
    "You are a helpful weather assistant. Always use the tool to get weather data. Be concise.";
  const thinkingConfig: ThinkingConfigEnabledParam = {
    type: "enabled",
    budget_tokens: 5000,
  };
  const messages: MessageParam[] = [
    { role: "user", content: "What's the weather in Tokyo?" },
  ];

  // Turn 1: Thinking + Tool Call
  console.log("=== Turn 1: Thinking + Tool Call ===");
  const response1 = await client.messages.create({
    model,
    max_tokens: 8000,
    system,
    thinking: thinkingConfig,
    tools,
    messages,
  });

  for (const block of response1.content) {
    if (block.type === "thinking") {
      console.log(`  [Thinking] ${block.thinking.slice(0, 80)}...`);
    } else if (block.type === "tool_use") {
      console.log(`  [Tool] ${block.name}(${JSON.stringify(block.input)})`);
    }
  }

  messages.push({ role: "assistant", content: response1.content });

  const toolUseBlock = response1.content.find((b) => b.type === "tool_use");
  if (!toolUseBlock || toolUseBlock.type !== "tool_use")
    throw new Error("Expected tool_use");
  const toolResult = getWeather(
    (toolUseBlock.input as Record<string, string>).city,
  );
  console.log(`  [Result] ${toolResult}`);
  messages.push({
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseBlock.id,
        content: toolResult,
      },
    ],
  });

  // Turn 2: Tool Result → Model Summarizes
  console.log("\n=== Turn 2: Tool Result → Model Summarizes ===");
  const response2 = await client.messages.create({
    model,
    max_tokens: 8000,
    system,
    thinking: thinkingConfig,
    tools,
    messages,
  });

  for (const block of response2.content) {
    if (block.type === "thinking") {
      console.log(`  [Thinking] ${block.thinking.slice(0, 80)}...`);
    } else if (block.type === "text") {
      console.log(`  [Response] ${block.text.slice(0, 200)}`);
    }
  }

  messages.push({ role: "assistant", content: response2.content });

  // Turn 3: Follow-up — model reasons over previous output
  console.log(
    "\n=== Turn 3: Follow-up — model reasons over previous output ===",
  );
  messages.push({
    role: "user",
    content:
      "What is that temperature in Fahrenheit? And should I bring a jacket?",
  });

  const response3 = await client.messages.create({
    model,
    max_tokens: 8000,
    system,
    thinking: thinkingConfig,
    messages,
  });

  for (const block of response3.content) {
    if (block.type === "thinking") {
      console.log(`  [Thinking] ${block.thinking.slice(0, 80)}...`);
    } else if (block.type === "text") {
      console.log(`  [Response] ${block.text.slice(0, 200)}`);
    }
  }

  instrumentor.uninstrument();
  await processor.forceFlush();
  await provider.shutdown();
  console.log("\n✓ All turns completed. Thinking blocks captured in traces.");
}

main().catch(console.error);
