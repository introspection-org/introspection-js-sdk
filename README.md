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

## Sign in a native app's users

A mobile or desktop app with its own sign-in screens registers a `native`
Application and signs its users in with emailed codes. Each session belongs to
a `customer` member, is refreshed for you, and calls the Data Plane:

```typescript
import { AuthClient } from "@introspection-sdk/introspection-node";

const auth = new AuthClient({ clientId: "intro_app_…", project: "my-project" });
await auth.signInWithOtp({ email });
await auth.verifyOtp({ email, token: code }); // 6 digits, or 6 letters and digits for a new user

const dp = await auth.dataPlane();
const run = await dp.tasks.start({ prompt: "Hello", runtime_id: runtimeId });
```

See the [Node package README](./packages/introspection-node/README.md#native-email-code-sign-in)
for refresh, storage and sign-out, and [`examples/api/native-email-code.ts`](./examples/api/native-email-code.ts).

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

To record an app event under your own name (`ark.feed.entry`), use
`logEvent(name, attributes?, { eventId? })`; `track` is an alias of it. See
[Logging custom events](packages/introspection-node/README.md#logging-custom-events)
for idempotency, reserved names, use from a recipe sandbox, and reading events
back.

In a browser, `@introspection-sdk/introspection-browser` records the same
signals. Give it a browser-safe telemetry token, never a project API key.

See [Product signals and tracing](https://docs.introspection.dev/sdk/javascript/product-signals).

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
- [Product signals and tracing](https://docs.introspection.dev/sdk/javascript/product-signals)
- [Platform operations](https://docs.introspection.dev/sdk/javascript/platform-operations)
- [JavaScript SDK reference](https://docs.introspection.dev/sdk/javascript/reference)
- [Authentication](https://docs.introspection.dev/sdk/authentication)

## Stream recovery

`run.stream()` attaches from cursor `0`, so it includes output produced before
the first connection. Only a settling `RUN_FINISHED` or `RUN_ERROR` confirms
completion and ends the stream; a `RUN_FINISHED` with
`result.reason = "stream_close"` marks the end of one attach and is not
forwarded. A severed connection reconnects. A connection that closes cleanly
without a settling event first reads that run's status
(`GET /v1/tasks/{task_id}/runs/{run_id}`): `failed` or `cancelled` throws
`RunFailedError`; `idle`, `completed` or `awaiting_user` means the run settled
without a complete stream and throws `StreamIncompleteError`; anything else,
including a status read that fails, reconnects.

Every reconnect resumes from the last content cursor (`Last-Event-ID`). Only a
new content cursor renews the recovery timeout (`timeoutMs`, default 5 minutes)
and resets the reconnect budget (`maxReconnects`, default 5 reconnects without
progress); lifecycle events, heartbeats and replayed content renew neither. The
timeout is checked before each retry, never during an open connection, so a long
stream keeps recovering past its original window as long as content advances. A
`429` means the run is not attachable yet: the stream waits (honouring
`Retry-After`) within the timeout without spending the reconnect budget.
`emitReconnectEvents: true` adds a `CUSTOM` `introspection.reconnect` event for
each reconnect or wait.

When the cursor is older than the server's replay buffer, the stream continues
with one AG-UI `MESSAGES_SNAPSHOT` holding the run's messages so far; its id
becomes the new cursor. When the server holds neither the frames nor a
snapshot, it answers `410` and the stream throws `StreamIncompleteError`.
Runtime images that predate the snapshot send `CUSTOM resume_gap` instead; raw
streams pass it through.

`run.text()` collects the assistant text: a `MESSAGES_SNAPSHOT` replaces what it
had read, `RUN_ERROR` throws `RunFailedError`, `resume_gap` throws
`StreamIncompleteError`, and every error the stream throws propagates, so it
never returns partial text. Recover final output from the conversation
transcript when needed; the SDK does not hydrate it automatically or require
the `conversations:read` scope just to stream.

Use a concrete run ID when consuming one turn. `runs/current` is a moving alias: a
reconnect or status read may resolve to the next turn if another run has started.

The in-process fake sandbox (`mock://`) supplies replies through the conversation
transcript, not SSE. Its attach-only `stream_close` cannot satisfy `.text()`; use
transcript reads for fake-sandbox tests, or a real runtime for `.text()` tests.

The shared `run-stream-contract.json` fixtures pin these behaviors across Swift,
JavaScript, Rust and Python. Each test suite pins the fixture SHA-256; intentional
contract changes must update all four copies and their expected hashes together.

JavaScript exports `StreamIncompleteError` and `RunFailedError` from the Node SDK and browser API entry point.

## License

Apache-2.0
