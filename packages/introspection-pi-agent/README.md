# introspection-pi-agent

Introspection observability extension for the
[Pi Agent SDK](https://github.com/badlogic/pi-mono) — emits OpenTelemetry
[GenAI semantic-convention](https://opentelemetry.io/docs/specs/semconv/gen-ai/)
spans for chat completions and tool execution.

## Installation

```bash
npm install @introspection-sdk/introspection-pi-agent \
  @opentelemetry/api \
  @mariozechner/pi-ai \
  @mariozechner/pi-agent-core
```

## Usage

```ts
import { trace } from "@opentelemetry/api";
import { Agent } from "@mariozechner/pi-agent-core";
import {
  instrumentAgent,
  instrumentStream,
  type AgentMeta,
} from "@introspection-sdk/introspection-pi-agent";

const tracer = trace.getTracer("my-app");
const meta: AgentMeta = {
  conversationId: "conv_123",
  agentId: "support-agent",
  agentName: "Support",
};

const agent = new Agent({
  /* … */
});

// One chat span per LLM call
agent.streamFn = instrumentStream(agent.streamFn, { tracer, meta });

// One execute_tool span per tool call
const tools = instrumentAgent(agent, { tracer, meta });

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
- `gen_ai.system_instructions`, `gen_ai.tool.definitions`
- `gen_ai.input.messages`, `gen_ai.output.messages`
- `gen_ai.response.id`, `gen_ai.response.finish_reasons`
- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`
- `gen_ai.usage.cache_read.input_tokens`, `gen_ai.usage.cache_creation.input_tokens` (when > 0)
- `gen_ai.cost.usd` (when reported)

For each tool call (`execute_tool ${tool_name}` span):

- `gen_ai.conversation.id`, `gen_ai.agent.id`, `gen_ai.agent.name`
- `gen_ai.operation.name = "execute_tool"`
- `gen_ai.tool.name`, `gen_ai.tool.type`, `gen_ai.tool.call.id`
- `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`
- Errors are recorded via `span.recordException` and `setStatus(ERROR)`

## License

Apache-2.0
