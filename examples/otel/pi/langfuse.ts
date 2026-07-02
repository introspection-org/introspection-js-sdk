/**
 * Pi Agent + Langfuse dual export — the explicit, bring-your-own-provider form.
 *
 * Construct the OTel `NodeTracerProvider` with the Introspection processor next
 * to the Langfuse one, register it, then `init({ tracerProvider })` adopts it.
 * The Pi instrumentor emits onto that provider, so every Pi span fans out to
 * both backends. (Pi agents are instrumented per instance, so you still call
 * `instrumentPi(agent, meta)`.)
 *
 * Run with: pnpm pi-langfuse
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY     - upstream provider key for the Pi agent
 *   INTROSPECTION_TOKEN   - Introspection API token
 *   LANGFUSE_PUBLIC_KEY   - Langfuse public key
 *   LANGFUSE_SECRET_KEY   - Langfuse secret key
 */

import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import * as introspection from "@introspection-sdk/introspection-node/otel";
import {
  IntrospectionSpanProcessor,
  type PiAgentMeta,
} from "@introspection-sdk/introspection-node/otel";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

function langfuseSpanProcessor(): BatchSpanProcessor {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  if (!publicKey || !secretKey) {
    throw new Error("LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set");
  }
  const baseUrl = process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com";
  return new BatchSpanProcessor(
    new OTLPTraceExporter({
      url: `${baseUrl}/api/public/otel/v1/traces`,
      headers: {
        Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}`,
      },
    }),
  );
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
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: "pi-langfuse" }),
    spanProcessors: [
      new IntrospectionSpanProcessor({
        token: process.env.INTROSPECTION_TOKEN,
      }),
      langfuseSpanProcessor(),
    ],
  });
  provider.register();

  await introspection.init({ tracerProvider: provider });

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
  console.log("✓ Exported to Introspection + Langfuse.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
