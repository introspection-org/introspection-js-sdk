/**
 * OpenAI + Langfuse Dual Export Example
 *
 * Multi-turn tool calling with dual export to Langfuse and Introspection.
 *
 * Run with: pnpm openinference-openai-langfuse
 */

import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OpenAIInstrumentation } from "@arizeai/openinference-instrumentation-openai";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { IntrospectionSpanProcessor } from "@introspection-sdk/introspection-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

if (!process.env.LANGFUSE_PUBLIC_KEY || !process.env.LANGFUSE_SECRET_KEY) {
  throw new Error("LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY must be set");
}

function getWeather(city: string): string {
  const data: Record<string, string> = {
    "San Francisco": "Foggy, 62°F",
    Tokyo: "Clear, 68°F",
  };
  return data[city] || `No data for ${city}`;
}

const langfuseAuth = Buffer.from(
  `${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`,
).toString("base64");
const langfuseBaseUrl =
  process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com";

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "openai-langfuse-example",
  }),
  spanProcessors: [
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: `${langfuseBaseUrl}/api/public/otel/v1/traces`,
        headers: { Authorization: `Basic ${langfuseAuth}` },
      }),
    ),
    new IntrospectionSpanProcessor({
      token: process.env.INTROSPECTION_TOKEN,
    }),
  ],
});
provider.register();

const instrumentation = new OpenAIInstrumentation();
instrumentation.manuallyInstrument(OpenAI);
registerInstrumentations({ instrumentations: [instrumentation] });

async function main() {
  const client = new OpenAI();
  const tools: ChatCompletionTool[] = [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get the current weather in a location",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string", description: "City name" },
          },
          required: ["city"],
        },
      },
    },
  ];

  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: "You are a helpful weather assistant. Be concise.",
    },
    {
      role: "user",
      content: "What's the weather in San Francisco and Tokyo?",
    },
  ];

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    tools,
  });

  const assistantMsg = response.choices[0].message;
  messages.push(assistantMsg);

  if (assistantMsg.tool_calls) {
    for (const tc of assistantMsg.tool_calls) {
      const args = JSON.parse(tc.function.arguments);
      const result = getWeather(args.city);
      console.log(
        `Tool call: ${tc.function.name}(${JSON.stringify(args)}) -> ${result}`,
      );
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result,
      });
    }
  }

  const response2 = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
  });
  console.log(`Response: ${response2.choices[0].message.content}`);

  await provider.forceFlush();
  await provider.shutdown();
}

main().catch(console.error);
