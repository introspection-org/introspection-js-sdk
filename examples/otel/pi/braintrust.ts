/**
 * Pi Agent + Braintrust dual export — the explicit, bring-your-own-provider form.
 *
 * Same shape as `langfuse.ts`: construct the OTel `NodeTracerProvider` with the
 * Introspection processor next to a Braintrust one, register it, then
 * `init({ tracerProvider })` adopts it. The Pi instrumentor emits onto that
 * provider, so every Pi span fans out to both backends. (Pi agents are
 * instrumented per instance, so you still call `instrumentPi(agent, meta)`.)
 *
 * Braintrust speaks OTLP, so the Introspection processor doubles as the
 * exporter for it — point a second instance at Braintrust's endpoint with the
 * project passed via the `x-bt-parent` header.
 *
 * Run with: pnpm pi-braintrust
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY     - upstream provider key for the Pi agent
 *   INTROSPECTION_TOKEN   - Introspection API token
 *   BRAINTRUST_API_KEY    - Braintrust API key
 */

import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import * as introspection from "@introspection-sdk/introspection-node/otel";
import {
  IntrospectionSpanProcessor,
  type PiAgentMeta,
} from "@introspection-sdk/introspection-node/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const SERVICE_NAME = "pi-braintrust";

function braintrustSpanProcessor(): IntrospectionSpanProcessor {
  const apiKey = process.env.BRAINTRUST_API_KEY;
  if (!apiKey) {
    throw new Error("BRAINTRUST_API_KEY must be set");
  }
  return new IntrospectionSpanProcessor({
    token: apiKey,
    advanced: {
      baseUrl: "https://api.braintrust.dev/otel/v1/traces",
      additionalHeaders: {
        "x-bt-parent": `project_name:${SERVICE_NAME}`,
      },
    },
  });
}

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
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: SERVICE_NAME }),
    spanProcessors: [
      new IntrospectionSpanProcessor({
        token: process.env.INTROSPECTION_TOKEN,
      }),
      braintrustSpanProcessor(),
    ],
  });
  provider.register();

  await introspection.init({ tracerProvider: provider });

  const agent = new Agent({
    streamFn: streamSimple,
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
  console.log("✓ Exported to Introspection + Braintrust.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
