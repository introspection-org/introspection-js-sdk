<div align="center">
  <a href="https://introspection.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/images/logo-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset=".github/images/logo-light.svg">
      <img alt="Introspection" src=".github/images/logo-light.svg" width="30%">
    </picture>
  </a>
</div>

<h4 align="center">Build frontier AI systems that self-improve.</h4>

<div align="center">
  <a href="https://introspection.dev"><img src="https://img.shields.io/badge/website-introspection.dev-blue" alt="Website"></a>
  <a href="https://www.npmjs.com/package/@introspection-sdk/introspection-node"><img src="https://img.shields.io/npm/v/@introspection-sdk/introspection-node?label=%20" alt="npm version"></a>
  <a href="https://www.apache.org/licenses/LICENSE-2.0"><img src="https://img.shields.io/badge/license-Apache%202.0-green" alt="License"></a>
  <a href="https://x.com/IntrospectionAI"><img src="https://img.shields.io/twitter/follow/IntrospectionAI" alt="Follow on X"></a>
</div>

<br>

[Introspection](https://introspection.dev) continuously improves your AI systems with production feedback and frontier practices. This is the JavaScript/TypeScript SDK.

## Packages

| Package                                     | Description                                                         |
| ------------------------------------------- | ------------------------------------------------------------------- |
| `@introspection-sdk/introspection-node`     | Node.js client with OpenTelemetry baggage context                   |
| `@introspection-sdk/introspection-browser`  | Browser client with localStorage persistence                        |
| `@introspection-sdk/types`                  | Shared types and constants                                          |
| `@introspection-sdk/introspection-openclaw` | [OpenClaw](https://openclaw.dev) plugin for agent lifecycle tracing |

## Install

```shell
pnpm add @introspection-sdk/introspection-node
# or
npm install @introspection-sdk/introspection-node
```

## Environment Variables

```shell
export INTROSPECTION_TOKEN="intro_xxx"
export INTROSPECTION_BASE_URL="https://otel.introspection.dev"  # optional
```

## Quickstart

### OpenTelemetry Span Processor

```typescript
import { IntrospectionSpanProcessor } from "@introspection-sdk/introspection-node";
import logfire from "@logfire/node";

const introspectionSpanProcessor = new IntrospectionSpanProcessor({
  token: process.env.INTROSPECTION_TOKEN,
});

logfire.configure({
  additionalSpanProcessors: [introspectionSpanProcessor],
});

logfire.instrumentOpenAI();
```

### OpenAI Agents SDK

```typescript
import { Agent, run, addTraceProcessor } from "@openai/agents";
import { IntrospectionTracingProcessor } from "@introspection-sdk/introspection-node";

const processor = new IntrospectionTracingProcessor();
addTraceProcessor(processor);

const agent = new Agent({ name: "my-agent", model: "gpt-4o" });
const result = await run(agent, "Hello!");

await processor.shutdown();
```

### Claude Agent SDK

```typescript
import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { withIntrospection } from "@introspection-sdk/introspection-node";

const tracedSdk = withIntrospection(sdk);

const stream = tracedSdk.query({
  prompt: "What is 2 + 2?",
  options: { model: "claude-sonnet-4-5-20250929", maxTurns: 1 },
});

for await (const message of stream) {
  // Process messages as usual
}

await tracedSdk.shutdown();
```

### Vercel AI SDK

```typescript
import { IntrospectionAISDKIntegration } from "@introspection-sdk/introspection-node";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const introspection = new IntrospectionAISDKIntegration();

const { text } = await generateText({
  model: openai("gpt-4o"),
  prompt: "Hello!",
  experimental_telemetry: { isEnabled: true, integrations: [introspection] },
});

await introspection.shutdown();
```

### Mastra

```typescript
import { Mastra } from "@mastra/core/mastra";
import { IntrospectionMastraExporter } from "@introspection-sdk/introspection-node/mastra";

const mastra = new Mastra({
  agents: { myAgent },
  observability: {
    configs: {
      otel: {
        serviceName: "my-mastra-app",
        exporters: [new IntrospectionMastraExporter()],
      },
    },
  },
});
```

### LangChain / LangGraph

```typescript
import { IntrospectionCallbackHandler } from "@introspection-sdk/introspection-node/langchain";
import { ChatOpenAI } from "@langchain/openai";

const handler = new IntrospectionCallbackHandler();
const model = new ChatOpenAI({ modelName: "gpt-4o" });
const response = await model.invoke("Hello!", { callbacks: [handler] });

await handler.shutdown();
```

> See [examples/](./examples/) for complete integration patterns including dual-export with Arize, Langfuse, Braintrust, and LangSmith.

## Client API

```typescript
import { IntrospectionClient } from "@introspection-sdk/introspection-node";

const client = new IntrospectionClient();

await client.withUserId("user_123", async () => {
  await client.withConversation("conv_456", "msg_123", async () => {
    client.feedback("thumbs_up", { comments: "Great response!" });
  });
});

await client.shutdown();
```

### Methods

| Method                      | Description                    |
| --------------------------- | ------------------------------ |
| `feedback(type, options?)`  | Track feedback on AI responses |
| `identify(userId, traits?)` | Associate a user with traits   |
| `track(event, properties?)` | Track any user action          |
| `flush()`                   | Flush pending events           |
| `shutdown()`                | Shutdown and flush             |

### Context Helpers

| Method                                         | Description                  |
| ---------------------------------------------- | ---------------------------- |
| `withUserId(id, callback)`                     | Set user context             |
| `withConversation(id?, responseId?, callback)` | Set conversation context     |
| `withAgent(name, id?, callback)`               | Set agent context            |
| `withAnonymousId(id, callback)`                | Set anonymous ID             |
| `withBaggage(values, callback)`                | Set arbitrary baggage values |

## Documentation

Full documentation is available at [docs.introspection.dev](https://docs.introspection.dev).
