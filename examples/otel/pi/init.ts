/**
 * Pi Agent + `introspection.init()` one-liner.
 *
 * `init()` discovers `@earendil-works/pi-agent-core` and binds a Pi instrumentor
 * to the shared provider. Because a Pi `Agent` is instrumented per instance, you
 * still hand each agent to `introspection.instrumentPi(agent, meta)` — the
 * equivalent of Python's `pi.instrument(agent)`.
 *
 * Run with: pnpm pi-init
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY    - upstream provider key for the Pi agent
 *   INTROSPECTION_TOKEN  - Introspection API token
 */

import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import * as introspection from "@introspection-sdk/introspection-node/otel";
import type { PiAgentMeta } from "@introspection-sdk/introspection-node/otel";

const weatherTool: AgentTool = {
  name: "get_weather",
  label: "Get weather",
  description: "Get the current weather for a city.",
  parameters: Type.Object({ city: Type.String() }),
  execute: async (_id, params) => {
    const city = (params as { city: string }).city;
    return {
      content: [{ type: "text", text: `${city}: Clear, 25°C` }],
      details: {},
    };
  },
};

async function main() {
  await introspection.init({ serviceName: "pi-init-example" });

  const agent = new Agent({
    initialState: {
      model: getBuiltinModel("anthropic", "claude-sonnet-4-6"),
      systemPrompt:
        "You are a weather assistant. Always call get_weather before answering.",
      tools: [weatherTool],
    },
  });

  const meta: PiAgentMeta = {
    conversationId: crypto.randomUUID(),
    agentId: "weather-agent",
    agentName: "Weather",
  };
  introspection.instrumentPi(agent, meta);

  await agent.prompt("What's the weather in Tokyo?");

  await introspection.shutdown();
  console.log("✓ Exported to Introspection.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
