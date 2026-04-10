/**
 * OpenAI + Arize/Phoenix Dual Export Example
 *
 * Multi-turn tool calling with dual export to Arize and Introspection.
 *
 * Run with: pnpm openinference-openai-arize
 */

import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { OpenAIInstrumentation } from "@arizeai/openinference-instrumentation-openai";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { IntrospectionSpanProcessor } from "@introspection-sdk/introspection-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const spaceId = process.env.ARIZE_SPACE_KEY;
const apiKey = process.env.ARIZE_API_KEY;

if (!spaceId || !apiKey) {
  throw new Error("ARIZE_SPACE_KEY and ARIZE_API_KEY must be set");
}

function getWeather(city: string): string {
  const data: Record<string, string> = {
    "San Francisco": "Foggy, 62°F",
    Tokyo: "Clear, 68°F",
  };
  return data[city] || `No data for ${city}`;
}

const arizeExporter = new OTLPTraceExporter({
  url: "https://otlp.arize.com/v1/traces",
  headers: { space_id: spaceId, api_key: apiKey },
});

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "openai-arize-example",
    "openinference.project.name": "openai-arize-example",
  }),
  spanProcessors: [
    new SimpleSpanProcessor(arizeExporter),
    new IntrospectionSpanProcessor({ token: process.env.INTROSPECTION_TOKEN }),
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
