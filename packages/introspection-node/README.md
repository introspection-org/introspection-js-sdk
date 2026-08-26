# @introspection-sdk/introspection-node

Node.js platform SDK for [Introspection](https://introspection.dev) — open runtimes,
drive tasks, and manage experiments, recipes, files, conversations, and shares.

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

const runner = await client.runtimes("customer-agent").run({
  agent_name: "support-agent",
  scope: "tasks:read tasks:write files:read files:write",
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

Runner creation also accepts `identity`, `caller`, and `ttl_seconds`, and the
resolved `runner.context` exposes the current runtime or experiment context.
`run.cancel()` aborts by default. Pass `{ mode: "abort" }` to make that
explicit, or `{ mode: "drain", drain_within_seconds: 60 }` for graceful
teardown.
Interrupted runs resume through
`runner.tasks.runs.resume(taskId, { resume: entries })`.

### Annotations

Annotations capture what a domain expert found good or bad on an OTel span. They
are labels, comments, and assignments—not numeric scores. Writes require an
authenticated business-member token with `annotations:write`; project API
keys and sandbox credentials cannot write annotations.

```typescript
const client = new IntrospectionClient({
  token: memberAccessToken,
  cpSession: encodedMemberSession,
  advanced: {
    baseApiUrl: "https://api.introspection.dev", // Control Plane
    dpUrl: memberDataPlaneUrl,
  },
});

const span = {
  trace_id: "0123456789abcdef0123456789abcdef",
  span_id: "0123456789abcdef",
};

await client.projectLabels.create({
  slug: "strong-structure",
  color: "#f97316",
  description: "A useful structure to preserve during distillation",
});
await client.annotations.create(span, { labels: ["strong-structure"] });
await client.annotations.create(span, {
  comment: "Keep the conclusion before the evidence.",
});
await client.annotations.create(span, {
  reviewerEmails: ["expert@example.com"],
});
await client.annotations.create(span, { reviewerEmails: [] });
```

Labels and reviewers are complete snapshots; pass `[]` to clear one. Comments
append. Every mutation gets a UUIDv7 `event_id` before its
first transport attempt, so an automatic retry remains one event. Supply
`{ event_id }` as the final method argument when retrying across processes.
`client.annotations.list()` and `client.projectLabels.list()` are both awaitable
for the first page and async-iterable across every cursor page.
Read immutable annotation history with
`client.events.list({ event_name: "introspection.annotation", trace_id, span_id })`.

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
    new BatchSpanProcessor(otherBackendExporter),
  ],
});
provider.register();

await introspection.init({ tracerProvider: provider });
```

`IntrospectionSpanProcessor` exports its own converted copy of each span, so the vendor processor receives the raw span and processor order is irrelevant. For a quick alternative: `init({ spanProcessors: [new BatchSpanProcessor(otherBackendExporter)] })`.

Pi is the only framework with a built-in integration. `init()` detects it and
wires it automatically; to instrument an `Agent` by hand, import
`IntrospectionPiInstrumentor` from
`@introspection-sdk/introspection-node/otel/pi`. It lives on its own subpath
because it reaches into `@earendil-works/pi-ai` at runtime, and the `/otel`
barrel must stay importable without it.

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

Attach the processor to a provider you already own, or stand one up with
`setupTracing`. Adding a second `IntrospectionSpanProcessor` pointed at another
OTLP endpoint dual-exports the same spans — see
[`examples/otel/pi/dual-export.ts`](../../examples/otel/pi/dual-export.ts).

```typescript
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { IntrospectionSpanProcessor } from "@introspection-sdk/introspection-node/otel";

const provider = new NodeTracerProvider({
  spanProcessors: [
    new IntrospectionSpanProcessor({ token: process.env.INTROSPECTION_TOKEN }),
  ],
});
provider.register();
```

## Environment variables

```shell
# Introspection API (IntrospectionClient)
export INTROSPECTION_TOKEN="intro_xxx"
export INTROSPECTION_BASE_API_URL="https://api.introspection.dev"   # optional

# Development only: route this process's tasks to your own `introspection dev`
# server when several developers share one Runtime. `introspection dev` prints
# the line to copy. No default.
export INTROSPECTION_DEV_TARGET="roland"                            # optional

# OTel (IntrospectionLogs + IntrospectionSpanProcessor)
export INTROSPECTION_BASE_OTEL_URL="https://otel.introspection.dev" # optional
export INTROSPECTION_SERVICE_NAME="my-service"                      # optional

# SDK diagnostics: error, warn, info, debug, verbose. Default: warn.
export INTROSPECTION_LOG_LEVEL="debug"                              # optional
```
