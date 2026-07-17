# @introspection-sdk/introspection-node

Node.js execution SDK for [Introspection](https://introspection.dev) — open configured
runtimes or experiments, then drive tasks, files, conversations, events, metrics, and shares.

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

const runner = await client.runtime("customer-agent").run({
  agent_name: "agent",
  scope:
    "tasks:read tasks:write files:read files:write events:read metrics:read",
});

const run = await runner.tasks.start({
  prompt: "Say hello in one sentence.",
});

for await (const event of run.stream()) {
  console.log(event.type);
}

await runner.close();
await client.shutdown();
```

## Pi instrumentation

Pi is the supported agent-instrumentation path:

```shell
pnpm add @earendil-works/pi-agent-core @earendil-works/pi-ai
```

```typescript
import * as introspection from "@introspection-sdk/introspection-node/otel";
import { Agent } from "@earendil-works/pi-agent-core";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

await introspection.init({ serviceName: "my-app" });

const agent = new Agent({
  initialState: {
    model: getBuiltinModel("anthropic", "claude-sonnet-4-6"),
    systemPrompt: "You are a helpful support agent.",
  },
});
introspection.instrumentPi(agent, {
  conversationId: "conv_123",
  agentId: "support-agent",
  agentName: "Support",
});

await agent.prompt("Help me understand my latest invoice.");
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

Support for other frameworks is experimental.

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

## OpenTelemetry span processor

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

## Environment variables

```shell
export INTROSPECTION_TOKEN="intro_xxx"
export INTROSPECTION_BASE_API_URL="https://api.introspection.dev"   # optional
export INTROSPECTION_BASE_OTEL_URL="https://otel.introspection.dev" # optional
export INTROSPECTION_SERVICE_NAME="my-service"                      # optional
```
