/**
 * Claude Agent SDK + Braintrust + Introspection Example
 *
 * Demonstrates dual tracing with:
 * - Braintrust (via OTLP export to Braintrust's OTEL endpoint)
 * - Introspection (via withIntrospection wrapper with CompositeSpanExporter)
 *
 * Uses a CompositeSpanExporter to send the same spans to both Braintrust and
 * Introspection simultaneously through the wrapper's internal TracerProvider.
 *
 * Requires: BRAINTRUST_API_KEY, INTROSPECTION_TOKEN, ANTHROPIC_API_KEY
 *
 * Run with: pnpm claude-agent-braintrust
 */

import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import type { SpanExporter, ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { withIntrospection } from "@introspection-sdk/introspection-node";
import { z } from "zod/v4";

if (!process.env.BRAINTRUST_API_KEY) {
  throw new Error("BRAINTRUST_API_KEY must be set");
}
if (!process.env.INTROSPECTION_TOKEN) {
  throw new Error("INTROSPECTION_TOKEN must be set");
}

// --- Composite exporter: sends spans to multiple destinations ---
// ExportResultCode values from @opentelemetry/core (inlined to avoid extra dep)
const SUCCESS = 0;
const FAILED = 1;

class CompositeSpanExporter implements SpanExporter {
  constructor(private exporters: SpanExporter[]) {}

  export(
    spans: ReadableSpan[],
    resultCallback: (result: { code: number }) => void,
  ): void {
    let completed = 0;
    let hasError = false;
    for (const exporter of this.exporters) {
      exporter.export(spans, (result) => {
        if (result.code === FAILED) hasError = true;
        completed++;
        if (completed === this.exporters.length) {
          resultCallback({ code: hasError ? FAILED : SUCCESS });
        }
      });
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.exporters.map((e) => e.shutdown()));
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.exporters.map((e) => e.forceFlush?.()));
  }
}

// --- Braintrust exporter ---
const braintrustExporter = new OTLPTraceExporter({
  url: "https://api.braintrust.dev/otel/v1/traces",
  headers: {
    Authorization: `Bearer ${process.env.BRAINTRUST_API_KEY}`,
    "x-bt-parent": "project_name:claude-agent-braintrust-example",
  },
});

// --- Introspection exporter ---
const baseUrl =
  process.env.INTROSPECTION_BASE_URL || "https://otel.introspection.dev";
const introspectionEndpoint = `${baseUrl.replace(/\/$/, "")}/v1/traces`;

const introspectionExporter = new OTLPTraceExporter({
  url: introspectionEndpoint,
  headers: {
    Authorization: `Bearer ${process.env.INTROSPECTION_TOKEN}`,
  },
});

// --- Wrap SDK with composite exporter for dual export ---
const tracedSdk = withIntrospection(sdk, {
  serviceName: "travel-assistant",
  advanced: {
    spanExporter: new CompositeSpanExporter([
      braintrustExporter,
      introspectionExporter,
    ]),
  },
});

// --- MCP tools ---
const getWeather = sdk.tool(
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

const getAttractions = sdk.tool(
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

const weatherServer = sdk.createSdkMcpServer({
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

console.log("Exporting traces to Braintrust + Introspection");
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

console.log("\nFlushing spans...");
await tracedSdk.forceFlush();
await new Promise((resolve) => setTimeout(resolve, 2000));

console.log("Done! Traces exported to:");
console.log("  - Braintrust (via CompositeSpanExporter)");
console.log("  - Introspection (via CompositeSpanExporter)");

await tracedSdk.shutdown();
