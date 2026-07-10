# Introspection SDK Examples

## Setup

```bash
cp .env.example .env   # fill in API keys
pnpm install
```

## Apps

Full runnable apps (their own package + README), not single scripts:

- [`auth`](./auth) — B2B2C auth modes (JWKS federation, hosted-login SPA,
  service account) and a partner MCP server authenticated by per-application
  identity-assertion signing keys. `cd auth` and see its README to set up and
  run.

## REST API

```bash
pnpm api-runtimes                 # Runner walkthrough: resolve by slug, tasks + file ops
```

## Egress Proxy

Route third-party API calls through the Introspection egress (reverse) proxy so
credentials are injected by the proxy instead of held in the process. Set
`INTROSPECTION_EGRESS_URL` (e.g. `http://localhost:10000`); when unset the helpers are
no-ops and code talks to the APIs directly.

There are two ways to wire it, compared on Supabase:

- **Global** — `installProxyFetch()` swaps `globalThis.fetch` once; the whole
  process routes through the proxy.
- **Manual** — `createProxyFetch()` is passed to a single client (e.g.
  supabase-js's `global.fetch`); only that client is proxied.

```bash
pnpm proxy-supabase-global        # installProxyFetch(): swaps global fetch, whole process
pnpm proxy-supabase-manual        # createProxyFetch(): scoped to one supabase-js client
pnpm proxy-typesense              # Typesense (axios): installProxyFetch + axiosAdapter "fetch"
pnpm proxy-deepwiki               # DeepWiki MCP (@modelcontextprotocol/sdk) via transport fetch
```

For **axios-based clients (e.g. Typesense), use the global install** — axios has
no per-client `fetch` option (its built-in fetch adapter always uses the global
fetch), so `installProxyFetch()` + `axiosAdapter: "fetch"` is the recommended
pattern. `fetch`-native clients (supabase-js, the MCP SDK) can use either.

## Pi instrumentation

Pi is the supported agent-instrumentation path.

```bash
pnpm pi-native                    # IntrospectionPiInstrumentor
pnpm pi-init                      # introspection.init() + instrumentPi(agent, meta)
pnpm pi-langfuse                  # + Langfuse dual export (explicit provider)
pnpm pi-subagents                 # Multi-agent baggage
```

## Experimental support for other frameworks

These framework examples are experimental.

### OpenAI Agents SDK

```bash
pnpm openai-agents                # Basic tracing
pnpm openai-agents-init           # introspection.init() one-liner
pnpm openai-agents-braintrust     # + Braintrust dual export
pnpm openai-agents-arize          # + Arize dual export
pnpm openai-agents-langsmith      # + LangSmith dual export
pnpm openai-agents-langfuse       # + Langfuse dual export
```

### Claude Agent SDK

```bash
pnpm claude-agent                 # withIntrospection() wrapper
pnpm claude-agent-init            # introspection.init() + instrumentClaudeAgent(sdk)
pnpm claude-agent-braintrust      # + Braintrust dual export
pnpm claude-agent-langsmith       # + LangSmith dual export
pnpm claude-agent-langfuse        # + Langfuse dual export
```

### Vercel AI SDK

```bash
pnpm ai-sdk                       # Vercel AI SDK native telemetry
pnpm ai-sdk-init                  # introspection.init() one-liner
pnpm ai-sdk-langfuse              # + Langfuse dual export (explicit provider)
pnpm ai-sdk-subagents             # Multi-agent baggage
```

### Mastra

```bash
pnpm mastra-ai                    # IntrospectionMastraExporter
pnpm mastra-init                  # introspection.init() + getMastraExporter()
pnpm mastra-braintrust            # + Braintrust dual export
pnpm mastra-arize                 # + Arize dual export
pnpm mastra-langsmith             # + LangSmith dual export
pnpm mastra-langfuse              # + Langfuse dual export
pnpm mastra-cloud                 # Mastra Cloud
```

### LangChain / LangGraph

```bash
pnpm langchain-handler            # IntrospectionCallbackHandler
pnpm langchain-handler-init       # introspection.init() + getLangchainHandler()
pnpm langchain-subagents          # Multi-agent baggage
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
pnpm anthropic-init               # introspection.init() one-liner
pnpm anthropic-langfuse           # + Langfuse dual export (explicit provider)
pnpm anthropic-subagents          # Multi-agent baggage
```

### Google Gemini (`@google/genai`)

```bash
pnpm gemini-native                # GeminiInstrumentor with thought signatures + tool use
pnpm gemini-init                  # introspection.init() one-liner
pnpm gemini-langfuse              # + Langfuse dual export (explicit provider)
```

Captures per-part `thoughtSignature` payloads (Gemini 2.5+ / 3.x) that must be
replayed on subsequent turns to preserve the model's chain of thought across
tool calls. See `otel/gemini/native.ts` for the multi-turn replay pattern.

## OpenInference (Third-Party / Unsupported Frameworks)

For frameworks that use OpenInference instrumentation. Uses `IntrospectionSpanProcessor` to convert OpenInference attributes to GenAI semantic conventions.

```bash
pnpm openinference-openai-arize        # Arize/Phoenix + Introspection
pnpm openinference-openai-braintrust   # Braintrust + Introspection
pnpm openinference-openai-langfuse     # Langfuse + Introspection
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
    anthropic/      # raw Anthropic SDK (@anthropic-ai/sdk)
    claude-agent/   # Claude Agent SDK (@anthropic-ai/claude-agent-sdk)
    gemini/         # Google Gemini (@google/genai)
    vercel/         # Vercel AI SDK
    mastra/         # Mastra
    langchain/      # LangChain / LangGraph
    openinference/  # OpenInference-based frameworks
    pi/             # Pi Agent
    openclaw/       # OpenClaw simulator
    raw/            # Raw OTEL (no framework)
    run_all.sh      # Run all OTel examples
```
