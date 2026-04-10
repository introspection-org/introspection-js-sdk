/**
 * Claude Agent SDK + LangSmith Wrapper + Introspection Example
 *
 * Demonstrates dual tracing with:
 * - LangSmith (via wrapClaudeAgentSDK wrapper)
 * - Introspection (via withIntrospection wrapper on top of LangSmith-wrapped SDK)
 *
 * The wrappers are chained: LangSmith wraps the original SDK first,
 * then withIntrospection wraps the result. Both see the same message stream.
 *
 * The wrapper produces these span types:
 * - claude.session: root span with gen_ai.* attributes (model, tokens, messages)
 * - tool.*: child spans for each tool call (gen_ai.tool.name, input, output)
 * - subagent.*: child spans for delegated subagent executions (gen_ai.agent.name)
 *
 * Requires: LANGSMITH_API_KEY, INTROSPECTION_TOKEN, ANTHROPIC_API_KEY
 *
 * Run with: pnpm claude-agent-langsmith
 */

import * as originalSdk from "@anthropic-ai/claude-agent-sdk";
import { wrapClaudeAgentSDK } from "langsmith/experimental/anthropic";
import { withIntrospection } from "@introspection-sdk/introspection-node";
import { z } from "zod/v4";

if (!process.env.LANGSMITH_API_KEY) {
  throw new Error("LANGSMITH_API_KEY must be set");
}
if (!process.env.INTROSPECTION_TOKEN) {
  throw new Error("INTROSPECTION_TOKEN must be set");
}

process.env["LANGSMITH_TRACING"] = "true";

// Chain wrappers: LangSmith first, then Introspection
const langsmithSdk = wrapClaudeAgentSDK(originalSdk);
const tracedSdk = withIntrospection(langsmithSdk, {
  serviceName: "travel-assistant",
});

// --- MCP tools ---
const getWeather = originalSdk.tool(
  "get_weather",
  "Gets the current weather for a given city",
  { city: z.string() },
  async ({ city }) => {
    const weatherData: Record<string, string> = {
      "San Francisco": "Foggy, 62°F",
      "New York": "Sunny, 75°F",
      London: "Rainy, 55°F",
      Tokyo: "Clear, 68°F",
    };

    const weather = weatherData[city] ?? "Weather data not available";
    return { content: [{ type: "text" as const, text: weather }] };
  },
);

const getAttractions = originalSdk.tool(
  "get_attractions",
  "Gets the top attractions for a given city",
  { city: z.string(), limit: z.number().default(3) },
  async ({ city, limit }) => {
    const attractions: Record<string, string[]> = {
      "San Francisco": [
        "Golden Gate Bridge",
        "Alcatraz Island",
        "Fisherman's Wharf",
        "Chinatown",
      ],
      Tokyo: [
        "Senso-ji Temple",
        "Shibuya Crossing",
        "Meiji Shrine",
        "Tokyo Skytree",
      ],
    };

    const cityAttractions = (attractions[city] ?? ["No data available"]).slice(
      0,
      limit,
    );
    return {
      content: [{ type: "text" as const, text: cityAttractions.join(", ") }],
    };
  },
);

const weatherServer = originalSdk.createSdkMcpServer({
  name: "travel",
  version: "1.0.0",
  tools: [getWeather, getAttractions],
});

// --- Query with automatic instrumentation ---
const systemPrompt =
  "You are a friendly travel assistant. Use the available tools to look up " +
  "weather and attractions. Always call get_weather AND get_attractions for " +
  "each city before summarizing.";

const stream = tracedSdk.query({
  prompt:
    "I'm planning a trip — compare San Francisco and Tokyo. " +
    "What's the weather like, and what are the top 3 attractions in each city?",
  options: {
    model: "claude-sonnet-4-5-20250929",
    systemPrompt,
    mcpServers: { travel: weatherServer },
    allowedTools: ["mcp__travel__get_weather", "mcp__travel__get_attractions"],
  },
}) as AsyncIterable<Record<string, unknown>>;

console.log("Exporting traces to LangSmith + Introspection");
console.log(`  Service name: travel-assistant\n`);
console.log("Streaming response:\n");

for await (const message of stream) {
  if (message.type === "system" && message.subtype === "init") {
    console.log(
      `[Session started] ID: ${message.session_id}, Model: ${message.model}`,
    );
  } else if (message.type === "assistant") {
    const content = (message as { message?: { content?: unknown[] } }).message
      ?.content;
    if (content) {
      for (const block of content as Array<{
        type: string;
        text?: string;
        name?: string;
      }>) {
        if (block.type === "text" && block.text) {
          process.stdout.write(block.text);
        } else if (block.type === "tool_use" && block.name) {
          console.log(`\n[Tool call: ${block.name}]`);
        }
      }
    }
  } else if (message.type === "result") {
    console.log("\n\n--- Result ---");
    if (message.result) {
      console.log(`Output: ${message.result}`);
    }
    const usage = message.usage as
      | { input_tokens?: number; output_tokens?: number }
      | undefined;
    if (usage) {
      console.log(
        `Tokens: ${usage.input_tokens || 0} input, ${usage.output_tokens || 0} output`,
      );
    }
  }
}

console.log("\nDone! Traces exported to:");
console.log("  - LangSmith (via SDK wrapper)");
console.log("  - Introspection (via withIntrospection wrapper)");

await tracedSdk.shutdown();
