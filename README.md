<div align="center">
  <a href="https://introspection.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/images/logo-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset=".github/images/logo-light.svg">
      <img alt="Introspection" src=".github/images/logo-light.svg" width="30%">
    </picture>
  </a>
</div>

<h4 align="center">The infrastructure for long-horizon vertical agents.</h4>

<div align="center">
  <a href="https://introspection.dev"><img src="https://img.shields.io/badge/website-introspection.dev-blue" alt="Website"></a>
  <a href="https://www.npmjs.com/package/@introspection-sdk/introspection-node"><img src="https://img.shields.io/npm/v/@introspection-sdk/introspection-node?label=%20" alt="npm version"></a>
  <a href="https://www.apache.org/licenses/LICENSE-2.0"><img src="https://img.shields.io/badge/license-Apache%202.0-green" alt="License"></a>
  <a href="https://x.com/IntrospectionAI"><img src="https://img.shields.io/twitter/follow/IntrospectionAI" alt="Follow on X"></a>
</div>

[Introspection](https://introspection.dev) is the infrastructure for
long-horizon vertical agents, powered by Pi. Define an agent as a
[Recipe](https://pi.recipes) — agents, skills, policies, and evals in plain
source you own in Git — deploy it to a governed per-customer Runtime, and
improve it in production with conversations, observations, judges, and
experiments.

These are the JavaScript and TypeScript clients: run tasks against a deployed
runtime, record what users thought of the result, and instrument a
[Pi](https://github.com/badlogic/pi-mono) agent that runs in your own service.

## Install

```shell
pnpm add @introspection-sdk/introspection-node
```

## Run a task

```typescript
import {
  EventType,
  IntrospectionClient,
} from "@introspection-sdk/introspection-node";

const client = new IntrospectionClient(); // token from INTROSPECTION_TOKEN
const runner = await client.runtimes("customer-agent").run({
  identity: { user_id: "user_123" },
});

const handle = await runner.tasks.start({
  prompt: "Say hello in one sentence.",
});

for await (const event of handle.stream()) {
  if (event.type === EventType.TEXT_MESSAGE_CONTENT) {
    process.stdout.write(event.delta ?? "");
  }
}

await runner.close();
await client.shutdown();
```

Or wait for the finished answer instead of streaming:

```typescript
const handle = await runner.tasks.start({
  prompt: "Summarize my open tickets.",
});
console.log(await handle.text());
```

Continue the same task with a follow-up run:

```typescript
const followUp = await runner.tasks.runs.create(handle.run.task_id, {
  kind: "prompt",
  prompt: { text: "Now draft the reply." },
});
console.log(await followUp.text());
```

See [Tasks and streaming](https://docs.introspection.dev/sdk/javascript/tasks-and-streaming) for reconnects,
interrupts, and cancellation, and [Browser applications](https://docs.introspection.dev/sdk/javascript/browser-applications)
for running tasks from a browser through a backend token broker.

## Record feedback

The `/otel` entrypoint emits `track` / `feedback` / `identify` and attaches
them to the conversation the agent produced:

```typescript
import { IntrospectionLogs } from "@introspection-sdk/introspection-node/otel";

const analytics = new IntrospectionLogs({ serviceName: "support-app" });

analytics.identify("user_123", { plan: "pro" });
analytics.track("case_closed", { source: "web" });

await analytics.withConversation(conversationId, undefined, async () => {
  analytics.feedback("thumbs_up", { comments: "The answer solved it" });
});

await analytics.shutdown();
```

In a browser, `@introspection-sdk/introspection-browser` records the same three
signals. Give it a browser-safe telemetry token, never a project API key.

See [Product signals and external agents](https://docs.introspection.dev/sdk/javascript/product-signals).

## Instrument a Pi agent

When the agent runs in a service you own rather than an Introspection runtime,
`init()` sets up tracing and wires up Pi:

```shell
pnpm add @earendil-works/pi-agent-core @earendil-works/pi-ai
```

```typescript
import * as introspection from "@introspection-sdk/introspection-node/otel";
import { Agent } from "@earendil-works/pi-agent-core";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";

await introspection.init({ serviceName: "my-app" });

const agent = new Agent({
  streamFn: streamSimple,
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

Spans in the OpenTelemetry GenAI semantic conventions are exported as they are.

Read the durable record of any of this with
[Production evidence](https://docs.introspection.dev/sdk/javascript/production-evidence), and give an agent
durable inputs with [Files and shares](https://docs.introspection.dev/sdk/javascript/files-and-shares).

## Packages

| Package                                                                         | Description                                                                       |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [`@introspection-sdk/introspection-node`](./packages/introspection-node/)       | Server-side client for runtimes, tasks, files, conversations, and product signals |
| [`@introspection-sdk/introspection-browser`](./packages/introspection-browser/) | Browser client for token-brokered applications                                    |
| [`@introspection-sdk/introspection-pi`](./packages/introspection-pi/)           | Pi Agent SDK instrumentation                                                      |
| [`@introspection-sdk/introspection-proxy`](./packages/introspection-proxy/)     | Egress proxy helpers                                                              |
| [`@introspection-sdk/http`](./packages/introspection-http/)                     | HTTP transport, AG-UI stream parsing, pagination                                  |
| [`@introspection-sdk/types`](./packages/introspection-types/)                   | Shared types and constants                                                        |
| [`@introspection-sdk/coding-agent`](./packages/introspection-coding-agent/)     | Opt-in capture of coding-agent plugin sessions                                    |

## Environment variables

```shell
export INTROSPECTION_TOKEN="intro_xxx"
export INTROSPECTION_SERVICE_NAME="my-service"   # optional
export INTROSPECTION_LOG_LEVEL="debug"           # optional
```

## Documentation

- [JavaScript quickstart](https://docs.introspection.dev/sdk/javascript/quickstart)
- [Tasks and streaming](https://docs.introspection.dev/sdk/javascript/tasks-and-streaming)
- [Browser applications](https://docs.introspection.dev/sdk/javascript/browser-applications)
- [Files and shares](https://docs.introspection.dev/sdk/javascript/files-and-shares)
- [Production evidence](https://docs.introspection.dev/sdk/javascript/production-evidence)
- [Product signals and external agents](https://docs.introspection.dev/sdk/javascript/product-signals)
- [Platform operations](https://docs.introspection.dev/sdk/javascript/platform-operations)
- [JavaScript SDK reference](https://docs.introspection.dev/sdk/javascript/reference)
- [Authentication](https://docs.introspection.dev/sdk/authentication)

## License

Apache-2.0
