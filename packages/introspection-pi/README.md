# introspection-pi

Introspection observability extension for the
[Pi Agent SDK](https://github.com/badlogic/pi-mono) — emits OpenTelemetry
[GenAI semantic-convention](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
spans for chat completions and tool execution.

## Installation

```bash
npm install @introspection-sdk/introspection-pi \
  @opentelemetry/api \
  @earendil-works/pi-ai \
  @earendil-works/pi-agent-core
```

## Usage

### One-call session attach

Hosts holding a live coding-agent session (an object exposing `agent` and
`sessionManager`) attach everything at once — chat spans through the
wrapped stream function, `execute_tool` spans per tool call, one
`invoke_agent` span per run that the others nest under, and structural
compaction detection from the session tree:

```ts
import { trace } from "@opentelemetry/api";
import { instrumentSession } from "@introspection-sdk/introspection-pi";

const handle = instrumentSession(session, {
  tracer: trace.getTracer("my-app"),
  meta: { conversationId, agentId, agentName },
});

// Later, on shutdown — restores the stream function, finalizes open spans:
handle.detach();
```

Hosts that already create their own turn/run spans keep their topology:

```ts
instrumentSession(session, {
  tracer,
  meta,
  runSpans: false,
  getParentContext: () => currentTurnContext,
  abortTerminationReason: () => (userRequestedStop ? "cancelled" : null),
  extraAttributes: () => ({ "tenant.id": tenantId }),
});
```

### Composing the pieces yourself

```ts
import { trace } from "@opentelemetry/api";
import { Agent } from "@earendil-works/pi-agent-core";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import {
  instrumentAgent,
  instrumentStream,
  type AgentMeta,
} from "@introspection-sdk/introspection-pi";

const tracer = trace.getTracer("my-app");
const meta: AgentMeta = {
  conversationId: "conv_123",
  agentId: "support-agent",
  agentName: "Support",
};

const agent = new Agent({
  initialState: {
    model: getBuiltinModel("anthropic", "claude-sonnet-4-6"),
    systemPrompt: "You are a helpful support agent.",
  },
});

// One chat span per LLM call
agent.streamFn = instrumentStream(agent.streamFn, { tracer, meta });

// One execute_tool span per tool call
const tools = instrumentAgent(agent, { tracer, meta });

await agent.prompt("Help me understand my latest invoice.");

// Later, on shutdown:
tools.stop();
```

### Adding caller-specific attributes

Use the `extraAttributes` hook to layer non-semconv attributes on every
chat span (tenant labels, correlation IDs, feature flags):

```ts
agent.streamFn = instrumentStream(agent.streamFn, {
  tracer,
  meta,
  extraAttributes: (model, ctx) => ({
    "introspection.byok": !process.env.PROXY_KEY,
    "tenant.id": meta.conversationId,
  }),
});
```

### Parenting spans under a turn span

If you wrap an entire user turn in your own span, pass
`getParentContext` so each chat / tool span lands under it:

```ts
const turnSpan = tracer.startSpan(`turn ${meta.agentName}`);
const turnContext = trace.setSpan(context.active(), turnSpan);

agent.streamFn = instrumentStream(agent.streamFn, {
  tracer,
  meta,
  getParentContext: () => turnContext,
});
```

## What gets emitted

For each LLM call (`chat ${provider}` span):

- `gen_ai.conversation.id`, `gen_ai.agent.id`, `gen_ai.agent.name`
- `gen_ai.operation.name = "chat"`
- `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.response.model`
- `gen_ai.request.stream = true`
- `gen_ai.system_instructions`, `gen_ai.tool.definitions`
- `gen_ai.input.messages`, `gen_ai.output.messages`
- `gen_ai.response.id`, `gen_ai.response.finish_reasons`
- `gen_ai.response.time_to_first_chunk`
- `gen_ai.conversation.compacted` when compacted history was sent
- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`
- `gen_ai.usage.reasoning.output_tokens` when reported
- `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens` (when > 0)
- `gen_ai.cost.usd` (when reported)
- `introspection.termination_reason = "cancelled" | "awaiting_user"` for requested aborts

Requested aborts are not recorded as errors. A user/runtime cancellation or an
interrupt pause ends the span with `gen_ai.response.finish_reasons = ["aborted"]`
and `introspection.termination_reason`, but without `setStatus(ERROR)` or a
synthetic exception. Unclaimed aborts and provider/model failures are still
recorded as errors with a standard exception span event.

For each tool call (`execute_tool ${tool_name}` span):

- `gen_ai.conversation.id`, `gen_ai.agent.id`, `gen_ai.agent.name`
- `gen_ai.operation.name = "execute_tool"`
- `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.tool.call.id`
- `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`
- Tool results are retained for both successful and failed executions so the
  conversation can be reconstructed losslessly. Tool errors are recorded with
  `setStatus(ERROR)`. Tool calls cut short by a
  requested abort are marked with `introspection.termination_reason =
"cancelled"` and are not marked as errors.

## Content scrubbing

gen_ai spans carry full conversation content. Hosts that export one span
stream to two backends with different data policies — whole spans to a
conversation store, structure-only to infrastructure observability — wrap
the second backend's exporter:

```ts
import { GenAiContentScrubbingExporter } from "@introspection-sdk/introspection-pi";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";

new BatchSpanProcessor(
  new GenAiContentScrubbingExporter(new OTLPTraceExporter()),
);
```

The wrapper strips the content-bearing attributes (input/output messages,
system instructions, tool definitions/arguments/results, and the
`gen_ai_encrypted.*` mirror) while keeping the structural signal
(operation, provider, model, usage, timing, tool names). Scrubbing is
decided per attribute on every span — content keys only exist on gen_ai
spans, so no scope configuration is needed and none can fail open — and
the original span object is never mutated, so a second processor on the
same stream still sees it whole. `isGenAiContentAttribute(key)` exposes
the predicate for hosts that scrub in their own pipeline.

## License

Apache-2.0
