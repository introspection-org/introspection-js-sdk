/**
 * OpenAI + Braintrust Dual Export Example
 *
 * Multi-turn tool calling with dual export to Braintrust and Introspection.
 *
 * Run with: pnpm openinference-openai-braintrust
 */

import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { OpenAIInstrumentation } from "@arizeai/openinference-instrumentation-openai";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { IntrospectionSpanProcessor } from "@introspection-sdk/introspection-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

if (!process.env.BRAINTRUST_API_KEY) {
  throw new Error("BRAINTRUST_API_KEY must be set");
}

function getWeather(city: string): string {
  const data: Record<string, string> = {
    "San Francisco": "Foggy, 62°F",
    Tokyo: "Clear, 68°F",
  };
  return data[city] || `No data for ${city}`;
}

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "openai-braintrust-example",
  }),
  spanProcessors: [
    new IntrospectionSpanProcessor({
      token: process.env.BRAINTRUST_API_KEY,
      advanced: {
        baseUrl: "https://api.braintrust.dev/otel/v1/traces",
        additionalHeaders: {
          "x-bt-parent": "project_name:openai-braintrust-example",
        },
      },
    }),
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
