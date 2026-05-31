# Introspection SDK Examples

## Setup

```bash
cp .env.example .env   # fill in API keys
pnpm install
```

## REST API

```bash
pnpm api-runtimes                 # Runner walkthrough: resolve by name, tasks + file ops
```

## Egress Proxy

Route third-party API calls through the Introspection egress (reverse) proxy so
credentials are injected by the proxy instead of held in the process. Set
`EGRESS_PROXY_URL` (e.g. `http://localhost:10000`); when unset the helpers are
no-ops and code talks to the APIs directly.

```bash
pnpm proxy-supabase               # supabase-js via createProxyFetch (fetch-based)
pnpm proxy-typesense              # Typesense via installProxyFetch + axiosAdapter "fetch"
```

## First-Party Integrations (OTel)

### OpenAI Agents SDK

```bash
pnpm openai-agents                # Basic tracing
pnpm openai-agents-braintrust     # + Braintrust dual export
pnpm openai-agents-arize          # + Arize dual export
pnpm openai-agents-langsmith      # + LangSmith dual export
pnpm openai-agents-langfuse       # + Langfuse dual export
```

### Claude Agent SDK

```bash
pnpm claude-agent                 # withIntrospection() wrapper
pnpm claude-agent-braintrust      # + Braintrust dual export
pnpm claude-agent-langsmith       # + LangSmith dual export
pnpm claude-agent-langfuse        # + Langfuse dual export
```

### Vercel AI SDK

```bash
pnpm ai-sdk                       # Vercel AI SDK native telemetry
```

### Mastra

```bash
pnpm mastra-ai                    # IntrospectionMastraExporter
pnpm mastra-braintrust            # + Braintrust dual export
pnpm mastra-arize                 # + Arize dual export
pnpm mastra-langsmith             # + LangSmith dual export
pnpm mastra-langfuse              # + Langfuse dual export
pnpm mastra-cloud                 # Mastra Cloud
```

### LangChain / LangGraph

```bash
pnpm langchain-handler            # IntrospectionCallbackHandler
```

For LangGraph, pass the app's session id in `configurable.thread_id`. The
callback handler maps that internal LangGraph thread id to
`gen_ai.conversation.id`, so each graph thread appears as a distinct
Introspection conversation.

```typescript
const threadId = "user-session-123";
await graph.invoke(input, {
  callbacks: [handler],
  configurable: { thread_id: threadId },
});
```

### Anthropic SDK (`@anthropic-ai/sdk`)

```bash
pnpm anthropic-native             # AnthropicInstrumentor with extended thinking + tool use
```

### Google Gemini (`@google/genai`)

```bash
pnpm gemini-native                # GeminiInstrumentor with thought signatures + tool use
```

Captures per-part `thoughtSignature` payloads (Gemini 2.5+ / 3.x) that must be
replayed on subsequent turns to preserve the model's chain of thought across
tool calls. See `otel/gemini-sdk/gemini-native.ts` for the multi-turn replay pattern.

## OpenInference (Third-Party / Unsupported Frameworks)

For frameworks that use OpenInference instrumentation. Uses `IntrospectionSpanProcessor` to convert OpenInference attributes to GenAI semantic conventions.

```bash
pnpm openinference-arize           # Arize/Phoenix + Introspection
pnpm openinference-braintrust      # Braintrust + Introspection
pnpm openinference-langfuse        # Langfuse + Introspection
```

### Raw OTEL

```bash
pnpm raw-conversation              # Multi-turn conversation with raw OTel APIs
```

## Directory Structure

```
examples/
  api/              # REST API (no OTel)
  otel/             # OTel-based instrumentation examples
    openai/         # OpenAI Agents SDK
    anthropic/      # Claude Agent SDK
    anthropic-sdk/  # Anthropic SDK (@anthropic-ai/sdk)
    gemini-sdk/     # Google Gemini (@google/genai)
    vercel/         # Vercel AI SDK
    mastra/         # Mastra
    langchain/      # LangChain / LangGraph
    openinference/  # OpenInference-based frameworks
    pi/             # Pi Agent
    openclaw/       # OpenClaw simulator
    raw/            # Raw OTEL (no framework)
    run_all.sh      # Run all OTel examples
```
