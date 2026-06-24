# @introspection-sdk/introspection-node

Node.js SDK for [Introspection](https://introspection.dev) — API client, analytics events, and OpenTelemetry trace instrumentation.

## Install

```shell
pnpm add @introspection-sdk/introspection-node
```

For OTel features (analytics, traces, instrumentors), also install the peer dependencies:

```shell
pnpm add @opentelemetry/api @opentelemetry/api-logs \
  @opentelemetry/sdk-trace-base @opentelemetry/sdk-trace-node \
  @opentelemetry/sdk-logs @opentelemetry/exporter-trace-otlp-proto \
  @opentelemetry/exporter-logs-otlp-proto @opentelemetry/resources \
  @opentelemetry/semantic-conventions @opentelemetry/context-async-hooks \
  @opentelemetry/core
```

## Introspection API (runtimes, tasks, files)

The main Introspection API surface. No OTel packages required.

```typescript
import { IntrospectionClient } from "@introspection-sdk/introspection-node";

const client = new IntrospectionClient();

const runner = await client.runtimes("customer-agent").run();

const run = await runner.tasks.start({
  prompt: "Say hello in one sentence.",
});

for await (const event of run.stream()) {
  console.log(event.type);
}

await runner.close();
await client.shutdown();
```

## One-liner `introspection.init()`

`init()` auto-detects installed LLM frameworks (Anthropic, Gemini, OpenAI Agents, Vercel AI SDK, Claude Agent SDK, LangChain, Mastra, Pi) and wires them into a single shared trace pipeline:

```typescript
import * as introspection from "@introspection-sdk/introspection-node/otel";
import Anthropic from "@anthropic-ai/sdk";

await introspection.init({ serviceName: "my-app" });

const client = new Anthropic();
await introspection.conversation(() =>
  client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 256,
    messages: [{ role: "user", content: "Hello!" }],
  }),
);

introspection.track("Signed up", { plan: "pro" });
await introspection.shutdown();
```

Both import styles work:

```typescript
import {
  init,
  conversation,
  track,
} from "@introspection-sdk/introspection-node/otel";
```

### Dual export

Build the OpenTelemetry provider yourself with both span processors:

```typescript
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { IntrospectionSpanProcessor } from "@introspection-sdk/introspection-node/otel";

const provider = new NodeTracerProvider({
  spanProcessors: [
    new IntrospectionSpanProcessor({ token: process.env.INTROSPECTION_TOKEN }),
    new BatchSpanProcessor(langfuseExporter),
  ],
});
provider.register();

await introspection.init({ tracerProvider: provider });
```

`IntrospectionSpanProcessor` exports its own converted copy of each span, so the vendor processor receives the raw span and processor order is irrelevant. For a quick alternative: `init({ spanProcessors: [new BatchSpanProcessor(langfuseExporter)] })`.

Frameworks whose hooks are attached per-call (LangChain), per-config (Mastra), or per-instance (Pi, Claude Agent SDK) are bound by `init()` and exposed via accessors — `introspection.getLangchainHandler()`, `introspection.getMastraExporter()`, `introspection.instrumentPi(agent, meta)`, `introspection.instrumentClaudeAgent(sdk)`.

## Analytics events (track, feedback, identify)

```typescript
import { IntrospectionLogs } from "@introspection-sdk/introspection-node/otel";

const logs = new IntrospectionLogs({
  token: process.env.INTROSPECTION_TOKEN,
  serviceName: "my-service",
});

await logs.withUserId("user_123", async () => {
  await logs.withConversation("conv_456", "msg_123", async () => {
    logs.feedback("thumbs_up", { comments: "Great response!" });
  });
});

logs.track("Button Clicked", { buttonId: "submit" });
logs.identify("user_123", { email: "user@example.com" });

await logs.shutdown();
```

### Methods

| Method                      | Description                    |
| --------------------------- | ------------------------------ |
| `track(event, properties?)` | Track any user action          |
| `feedback(type, options?)`  | Track feedback on AI responses |
| `identify(userId, traits?)` | Associate a user with traits   |
| `flush()`                   | Flush pending events           |
| `shutdown()`                | Shutdown and flush             |

### Context helpers (OTel baggage)

| Method                                         | Description                  |
| ---------------------------------------------- | ---------------------------- |
| `withUserId(id, callback)`                     | Set user context             |
| `withConversation(id?, responseId?, callback)` | Set conversation context     |
| `withAgent(name, id?, callback)`               | Set agent context            |
| `withAnonymousId(id, callback)`                | Set anonymous ID             |
| `withBaggage(values, callback)`                | Set arbitrary baggage values |

## Framework integrations

### OpenTelemetry Span Processor

```typescript
import { IntrospectionSpanProcessor } from "@introspection-sdk/introspection-node/otel";
import logfire from "@logfire/node";

logfire.configure({
  additionalSpanProcessors: [
    new IntrospectionSpanProcessor({ token: process.env.INTROSPECTION_TOKEN }),
  ],
});

logfire.instrumentOpenAI();
```

### OpenAI Agents SDK

```typescript
import { Agent, run, addTraceProcessor } from "@openai/agents";
import { IntrospectionTracingProcessor } from "@introspection-sdk/introspection-node/otel";

const processor = new IntrospectionTracingProcessor();
addTraceProcessor(processor);

const agent = new Agent({ name: "my-agent", model: "gpt-4o" });
const result = await run(agent, "Hello!");

await processor.shutdown();
```

### Claude Agent SDK

```typescript
import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { withIntrospection } from "@introspection-sdk/introspection-node/otel";

const tracedSdk = withIntrospection(sdk);
const stream = tracedSdk.query({
  prompt: "What is 2 + 2?",
  options: { model: "claude-sonnet-4-5-20250929", maxTurns: 1 },
});

for await (const message of stream) {
  /* ... */
}
await tracedSdk.shutdown();
```

### Vercel AI SDK

```typescript
import { setupTracing } from "@introspection-sdk/introspection-node/otel";
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";

const provider = setupTracing({ serviceName: "my-app" });

const { text } = await generateText({
  model: openai("gpt-4o"),
  prompt: "Hello!",
  experimental_telemetry: { isEnabled: true },
});

await provider.shutdown();
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

For LangGraph, pass the app's session id as `thread_id`:

```typescript
await graph.invoke(input, {
  callbacks: [handler],
  configurable: { thread_id: "user-session-123" },
});
```

> See [examples/](../../examples/) for complete integration patterns including dual-export with Arize, Langfuse, Braintrust, and LangSmith.

## Environment variables

```shell
export INTROSPECTION_TOKEN="intro_xxx"
export INTROSPECTION_BASE_API_URL="https://api.introspection.dev"   # optional
export INTROSPECTION_BASE_OTEL_URL="https://otel.introspection.dev" # optional
export INTROSPECTION_SERVICE_NAME="my-service"                      # optional
```
