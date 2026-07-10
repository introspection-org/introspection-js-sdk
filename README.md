<div align="center">
  <a href="https://introspection.dev">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset=".github/images/logo-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset=".github/images/logo-light.svg">
      <img alt="Introspection" src=".github/images/logo-light.svg" width="30%">
    </picture>
  </a>
</div>

<h4 align="center">Deploy vertical agents that improve in production.</h4>

<div align="center">
  <a href="https://introspection.dev"><img src="https://img.shields.io/badge/website-introspection.dev-blue" alt="Website"></a>
  <a href="https://www.npmjs.com/package/@introspection-sdk/introspection-node"><img src="https://img.shields.io/npm/v/@introspection-sdk/introspection-node?label=%20" alt="npm version"></a>
  <a href="https://www.apache.org/licenses/LICENSE-2.0"><img src="https://img.shields.io/badge/license-Apache%202.0-green" alt="License"></a>
  <a href="https://x.com/IntrospectionAI"><img src="https://img.shields.io/twitter/follow/IntrospectionAI" alt="Follow on X"></a>
</div>

<br>

[Introspection](https://introspection.dev) is the managed cloud for vertical
agents, powered by Pi. Define an agent as a recipe, deploy it to a
commit-pinned runtime, and improve it in production with conversations,
patterns, judges, and experiments.

This repository contains the JavaScript and TypeScript clients for driving the
Introspection platform. Use them to open a runner against a deployed runtime,
start and stream tasks, and work with the platform from server and browser
applications. See the [SDK overview](https://docs.introspection.dev/sdk) for
where each client fits.

## Packages

| Package                                                                         | Description                                                                                     |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [`@introspection-sdk/introspection-node`](./packages/introspection-node/)       | Server-side platform client for runtimes, tasks, files, conversations, recipes, and experiments |
| [`@introspection-sdk/introspection-browser`](./packages/introspection-browser/) | Browser platform client for applications authenticated through a backend token broker           |
| [`@introspection-sdk/types`](./packages/introspection-types/)                   | Shared types and constants                                                                      |
| [`@introspection-sdk/introspection-pi`](./packages/introspection-pi/)           | Supported [Pi Agent SDK](https://withpi.ai) instrumentation                                     |
| [`@introspection-sdk/introspection-proxy`](./packages/introspection-proxy/)     | Egress proxy helpers — credential injection and CONNECT forward proxy                           |

## Quick start

```shell
pnpm add @introspection-sdk/introspection-node
```

### Introspection API (runtimes, tasks, files)

```typescript
import { IntrospectionClient } from "@introspection-sdk/introspection-node";

const client = new IntrospectionClient();
const runner = await client.runtimes("customer-agent").run();

const run = await runner.tasks.start({
  prompt: "Say hello in one sentence.",
});

for await (const event of run.stream()) {
  console.log(`[${event.event}] ${event.data}`);
}

await runner.close();
await client.shutdown();
```

#### Resilient streaming

`run.stream()` **resumes transparently** across a mid-turn disconnect — gateway
idle-timeout, load-balancer recycle, network blip. On a drop it re-attaches with
the SSE-standard `Last-Event-ID` so the server replays the frames you missed,
and the iterator yields one gap-free `AGUIEvent` sequence. There is no
consumer-visible change: the loop above just keeps working, completing when the
turn finishes and throwing only if recovery is exhausted. Pass an options object
to tune the recovery bounds:

```typescript
for await (const event of run.stream({
  maxReconnects: 5,
  timeoutMs: 300_000,
})) {
  console.log(`[${event.event}] ${event.data}`);
}
```

Readiness folds in the same way: while a run is not yet attachable the server
answers with `429` + `Retry-After`, which the stream honours as a backoff floor
and retries — never surfaced to the caller.

#### Retries (429 / 5xx)

Unary calls auto-retry on transient statuses with a capped-exponential backoff
(the server's `Retry-After` is honoured as a floor when present; if it's absent
the retry still happens, just on the plain exponential schedule):

- **`429 Too Many Requests`** — retried for **every** method (the request was
  rejected, not processed, so re-sending is safe even for writes). Covers
  `tasks.get` (status polling), lists, create, cancel, delete, file metadata.
- **`502` / `503` / `504`** — retried for **GET only** (idempotent reads); a
  transient gateway error on a write is surfaced rather than re-sent.

Retries are bounded (`maxRetries`, default 2; set `0` to disable). Once the
budget is spent the error surfaces (`RateLimitError` for 429,
`SandboxUnavailableError` for 503/504), each carrying `status`, `retryAfter`,
and `body` so you can decide how to back off further. Streaming has its own
resume budget (above); multipart uploads are not auto-retried.

### Pi instrumentation

Pi is the supported agent-instrumentation path. `init()` discovers Pi and wires
it into the shared trace pipeline:

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

> Support for other frameworks is experimental.

### Egress proxy

Route outbound `fetch` through the Introspection egress proxy for credential injection:

```typescript
import { installProxyFetch } from "@introspection-sdk/introspection-proxy";

installProxyFetch();

const res = await fetch("https://api.openai.com/v1/models");
```

Hosts in `INTROSPECTION_ENDPOINT_HOSTS` go through the egress reverse proxy for credential injection. All other hosts use the standard `HTTPS_PROXY` CONNECT tunnel.

> See the [introspection-proxy README](./packages/introspection-proxy/) for configuration details.

## Environment variables

```shell
export INTROSPECTION_TOKEN="intro_xxx"
export INTROSPECTION_BASE_API_URL="https://api.introspection.dev"   # optional
export INTROSPECTION_BASE_OTEL_URL="https://otel.introspection.dev" # optional
export INTROSPECTION_SERVICE_NAME="my-service"                      # optional
```

## Documentation

Full documentation is available at [docs.introspection.dev](https://docs.introspection.dev).

## License

Apache-2.0
