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

| Package                                     | Description                                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `@introspection-sdk/introspection-node`     | Node.js client with OpenTelemetry baggage context                                                         |
| `@introspection-sdk/introspection-browser`  | Browser client with localStorage persistence                                                              |
| `@introspection-sdk/types`                  | Shared types and constants                                                                                |
| `@introspection-sdk/introspection-openclaw` | [OpenClaw](https://openclaw.dev) plugin for agent lifecycle tracing                                       |
| `@introspection-sdk/introspection-pi`       | [Pi Agent SDK](https://withpi.ai) instrumentor — OTel GenAI spans for chat completions and tool execution |

## Three independent surfaces

The Node SDK exposes three surfaces you can adopt independently:

1. **Introspection API (runtimes, tasks, files)** with `IntrospectionClient` — the main Introspection API. Zero OpenTelemetry imports. Always available.
2. **Analytics events (track, feedback, identify)** with `IntrospectionLogs` — OTel logs exporter with baggage helpers. Owns its own `LoggerProvider`. Lives at `@introspection-sdk/introspection-node/otel`. Requires the OTel SDK peer deps.
3. **Traces (span processors + instrumentors)** with `IntrospectionSpanProcessor` and friends — `IntrospectionTracingProcessor`, `IntrospectionClaudeHooks`, `withIntrospection`, `AnthropicInstrumentor`, `GeminiInstrumentor`, `IntrospectionPiInstrumentor`, the LangChain callback handler, the Mastra exporter. All under `@introspection-sdk/introspection-node/otel` (or the dedicated `/langchain` and `/mastra` subpaths for the framework hooks).

## 1. Introspection API (runtimes, tasks, files) with `IntrospectionClient`

The main Introspection API surface. No OTel packages required — install just the SDK:

```shell
pnpm add @introspection-sdk/introspection-node
```

```typescript
import { IntrospectionClient } from "@introspection-sdk/introspection-node";

const client = new IntrospectionClient({
  token: process.env.INTROSPECTION_TOKEN,
  projectId: "proj_…",
});

const runner = await client.runtimes("customer-agent").run({
  identity: { user_id: "u_42" },
});
const run = await runner.tasks.create({ prompt: "Summarize this repo" });
for await (const ev of run.stream()) console.log(ev);

await runner.close();
await client.shutdown();
```

## 2. Analytics events (track, feedback, identify) with `IntrospectionLogs`

Install the SDK plus the OTel logs peer dependencies:

```shell
pnpm add @introspection-sdk/introspection-node \
  @opentelemetry/api-logs \
  @opentelemetry/sdk-logs \
  @opentelemetry/exporter-logs-otlp-proto \
  @opentelemetry/resources \
  @opentelemetry/semantic-conventions
```

```typescript
import { IntrospectionLogs } from "@introspection-sdk/introspection-node/otel";

const logs = new IntrospectionLogs({
  token: process.env.INTROSPECTION_TOKEN,
  serviceName: "my-service",
  baseOtelUrl: process.env.INTROSPECTION_BASE_OTEL_URL, // optional
  projectId: "proj_…", // optional
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

## 3. Traces (span processors + instrumentors) with `IntrospectionSpanProcessor`

Install the SDK plus the OTel trace peer dependencies:

```shell
pnpm add @introspection-sdk/introspection-node \
  @opentelemetry/api \
  @opentelemetry/sdk-trace-base \
  @opentelemetry/sdk-trace-node \
  @opentelemetry/exporter-trace-otlp-proto \
  @opentelemetry/context-async-hooks \
  @opentelemetry/core
```

### OpenTelemetry Span Processor

```typescript
import { IntrospectionSpanProcessor } from "@introspection-sdk/introspection-node/otel";
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
  // Process messages as usual
}

await tracedSdk.shutdown();
```

### Vercel AI SDK

The AI SDK emits gen*ai.* and ai.\_ attributes natively via OTel when telemetry is enabled. `setupTracing()` wires the global tracer with `IntrospectionSpanProcessor`, which converts the SDK's `ai.*` attributes to canonical `gen_ai.*` semconv at span end — works for any provider (OpenAI, Anthropic, Gemini, etc.).

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

For LangGraph, pass the app's session id as `thread_id`. The callback handler
maps that internal LangGraph thread id to `gen_ai.conversation.id`.

```typescript
const threadId = "user-session-123";
const response = await graph.invoke(input, {
  callbacks: [handler],
  configurable: { thread_id: threadId },
});
```

> See [examples/](./examples/) for complete integration patterns including dual-export with Arize, Langfuse, Braintrust, and LangSmith.

## Environment variables

```shell
# Introspection API (IntrospectionClient)
export INTROSPECTION_TOKEN="intro_xxx"
export INTROSPECTION_BASE_API_URL="https://api.introspection.dev"  # optional

# OTel (IntrospectionLogs + span processors + instrumentors)
export INTROSPECTION_BASE_OTEL_URL="https://otel.introspection.dev" # optional
export INTROSPECTION_SERVICE_NAME="my-service"                      # optional
```

> `INTROSPECTION_BASE_URL` was renamed to `INTROSPECTION_BASE_OTEL_URL` to disambiguate it from the REST API endpoint. There is no fallback to the old name.

## Documentation

Full documentation is available at [docs.introspection.dev](https://docs.introspection.dev).

## License

Apache-2.0
