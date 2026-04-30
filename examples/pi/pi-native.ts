/**
 * Pi Agent Native Instrumentation Example
 *
 * Wires `@introspection-sdk/introspection-pi` onto a `pi-agent-core` Agent
 * and runs a small multi-turn weather conversation with a tool call.
 *
 * Two spans land per LLM call:
 *   chat ${provider}             — `instrumentStream` wraps `agent.streamFn`
 *   execute_tool ${tool.name}    — `instrumentAgent` subscribes to the loop
 *
 * Run with: pnpm pi-native
 *
 * Required env:
 *   INTROSPECTION_TOKEN          (or the upstream provider key — e.g. ANTHROPIC_API_KEY)
 *
 * Optional:
 *   INTROSPECTION_BASE_URL       defaults to https://otel.introspection.dev
 */

import { Agent, type AgentTool } from "@mariozechner/pi-agent-core";
import { getModel, Type } from "@mariozechner/pi-ai";
import { trace } from "@opentelemetry/api";
import { IntrospectionSpanProcessor } from "@introspection-sdk/introspection-node";
import {
  instrumentAgent,
  instrumentStream,
  type AgentMeta,
} from "@introspection-sdk/introspection-pi";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

function getWeather(city: string): string {
  const data: Record<string, string> = {
    Tokyo: "Clear, 25°C",
    Paris: "Rainy, 12°C",
  };
  return data[city] ?? `No data for ${city}`;
}

async function main() {
  // ── 1. Set up the OTel pipeline ───────────────────────────────────────────
  const processor = new IntrospectionSpanProcessor({
    serviceName: "pi-native-example",
  });
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  provider.register();

  const tracer = trace.getTracer("pi-native-example");

  // ── 2. Build a pi-agent-core Agent with one tool ─────────────────────────
  const weatherTool: AgentTool = {
    name: "get_weather",
    label: "Get weather",
    description:
      "Get weather for a city. Returns conditions and temperature in Celsius.",
    parameters: Type.Object({ city: Type.String() }),
    execute: async (_id, params) => {
      const result = getWeather((params as { city: string }).city);
      return {
        content: [{ type: "text", text: result }],
        details: { result },
      };
    },
  };

  const agent = new Agent({
    initialState: {
      model: getModel("anthropic", "claude-sonnet-4-6"),
      systemPrompt:
        "You are a helpful weather assistant. Always use the tool to get weather data. Be concise.",
      tools: [weatherTool],
    },
  });

  // ── 3. Wire instrumentation ──────────────────────────────────────────────
  const meta: AgentMeta = {
    conversationId: crypto.randomUUID(),
    agentId: "weather-agent",
    agentName: "Weather",
  };

  // One `chat ${provider}` span per LLM call.
  agent.streamFn = instrumentStream(agent.streamFn, { tracer, meta });

  // One `execute_tool ${tool_name}` span per tool call.
  const toolInst = instrumentAgent(agent, { tracer, meta });

  // ── 4. Drive a multi-turn conversation ───────────────────────────────────
  console.log("=== Turn 1: Weather lookup ===");
  await agent.prompt("What's the weather in Tokyo?");
  printAssistant(agent);

  console.log(
    "\n=== Turn 2: Follow-up — model reasons over previous output ===",
  );
  await agent.prompt(
    "What is that temperature in Fahrenheit? And should I bring a jacket?",
  );
  printAssistant(agent);

  // ── 5. Tear down ─────────────────────────────────────────────────────────
  toolInst.stop();
  await processor.forceFlush();
  await provider.shutdown();
  console.log("\n✓ All turns completed. Spans flushed to Introspection.");
}

function printAssistant(agent: Agent): void {
  for (let i = agent.state.messages.length - 1; i >= 0; i--) {
    const msg = agent.state.messages[i];
    if (msg && msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "text") {
          console.log(`  [Response] ${block.text.slice(0, 200)}`);
        } else if (block.type === "toolCall") {
          console.log(
            `  [Tool] ${block.name}(${JSON.stringify(block.arguments)})`,
          );
        }
      }
      return;
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
