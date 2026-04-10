/**
 * LangChain First-Party Handler Example
 *
 * Demonstrates using IntrospectionCallbackHandler with tools, system
 * prompt, and a full agent loop (model → tool call → tool result → response).
 *
 * Also exports to LangSmith via LANGSMITH_* env vars (LangChain's built-in
 * LangSmith integration picks these up automatically).
 *
 * Run with: pnpm langchain-handler
 */

import { IntrospectionCallbackHandler } from "@introspection-sdk/introspection-node/langchain";
import { ChatOpenAI } from "@langchain/openai";
import { tool } from "@langchain/core/tools";
import {
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import type { AIMessage } from "@langchain/core/messages";
import { z } from "zod";

async function main() {
  const handler = new IntrospectionCallbackHandler({
    serviceName: "langchain-example",
  });

  console.log("Running LangChain agent with tools + system prompt...");

  const getWeather = tool(
    async ({ city }: { city: string }) => {
      const weather: Record<string, string> = {
        Boston: "Sunny, 72°F",
        Tokyo: "Cloudy, 65°F",
        Paris: "Rainy, 58°F",
      };
      return weather[city] || `Weather data unavailable for ${city}`;
    },
    {
      name: "get_weather",
      description: "Get the current weather for a city",
      schema: z.object({
        city: z.string().describe("The city name"),
      }),
    },
  );

  const model = new ChatOpenAI({
    modelName: "gpt-4o-mini",
  }).bindTools([getWeather]);

  const messages: BaseMessage[] = [
    new SystemMessage(
      "You are a helpful weather assistant. Always use the get_weather tool to answer weather questions. Be concise.",
    ),
    new HumanMessage("What's the weather in Tokyo?"),
  ];

  const callbacks = { callbacks: [handler] };

  // Agent loop: call model, execute tools, feed results back
  let response = (await model.invoke(messages, callbacks)) as AIMessage;
  messages.push(response);

  while (response.tool_calls && response.tool_calls.length > 0) {
    // Execute each tool call
    for (const tc of response.tool_calls) {
      console.log(`Calling tool: ${tc.name}(${JSON.stringify(tc.args)})`);
      const result = await getWeather.invoke(tc.args, callbacks);
      messages.push(new ToolMessage({ content: result, tool_call_id: tc.id! }));
    }

    // Call model again with tool results
    response = (await model.invoke(messages, callbacks)) as AIMessage;
    messages.push(response);
  }

  console.log("Response:", response.content);

  await handler.shutdown();
  console.log("Done — spans exported to Introspection.");
}

main().catch(console.error);
