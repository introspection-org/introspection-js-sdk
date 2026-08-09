/**
 * Pi Agent + a second OTLP backend — the explicit, bring-your-own-provider form.
 *
 * Construct the OTel `NodeTracerProvider` with the Introspection processor next
 * to a plain `BatchSpanProcessor` pointed at any other OTLP endpoint, register
 * it, then `init({ tracerProvider })` adopts it. The Pi instrumentor emits onto
 * that provider, so every Pi span fans out to both backends. (Pi agents are
 * instrumented per instance, so you still call `instrumentPi(agent, meta)`.)
 *
 * Nothing here is vendor-specific: point `OTEL_EXPORTER_OTLP_ENDPOINT` at
 * whichever OTLP-compatible collector you use and supply whatever auth header
 * it expects.
 *
 * Run with: pnpm pi-dual-export
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY             - upstream provider key for the Pi agent
 *   INTROSPECTION_TOKEN           - Introspection API token
 *   OTEL_EXPORTER_OTLP_ENDPOINT   - the second backend's OTLP traces endpoint
 *
 * Optional:
 *   OTEL_EXPORTER_OTLP_HEADERS    - "key=value,key2=value2" auth headers
 */

import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import * as introspection from "@introspection-sdk/introspection-node/otel";
import { IntrospectionSpanProcessor } from "@introspection-sdk/introspection-node/otel";
import type { PiAgentMeta } from "@introspection-sdk/introspection-node/otel/pi";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

function secondBackendProcessor(): BatchSpanProcessor {
  const url = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!url) {
    throw new Error("OTEL_EXPORTER_OTLP_ENDPOINT must be set");
  }
  // The standard "key=value,key2=value2" spelling, so this works with any
  // collector's auth scheme without the example knowing about it.
  const headers = Object.fromEntries(
    (process.env.OTEL_EXPORTER_OTLP_HEADERS ?? "")
      .split(",")
      .filter(Boolean)
      .map((pair) => {
        const index = pair.indexOf("=");
        return [pair.slice(0, index).trim(), pair.slice(index + 1).trim()];
      }),
  );
  return new BatchSpanProcessor(new OTLPTraceExporter({ url, headers }));
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
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: "pi-dual-export",
    }),
    spanProcessors: [
      new IntrospectionSpanProcessor({
        token: process.env.INTROSPECTION_TOKEN,
      }),
      secondBackendProcessor(),
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

  // `init({ tracerProvider })` does not take ownership of a provider you
  // built, so `introspection.shutdown()` leaves it running. Shut it down
  // yourself or the second backend's batch processor is never flushed.
  await introspection.shutdown();
  await provider.shutdown();
  console.log("✓ Exported to Introspection + the second backend.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
