# Introspection SDK Examples

## Setup

```bash
cp .env.example .env   # fill in API keys
pnpm install
```

## First-Party Integrations

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
pnpm ai-sdk                       # IntrospectionAISDKIntegration
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
  openai/           # OpenAI Agents SDK
  anthropic/        # Claude Agent SDK
  vercel/           # Vercel AI SDK
  mastra/           # Mastra
  langchain/        # LangChain / LangGraph
  openinference/    # OpenInference-based frameworks
  raw/              # Raw OTEL (no framework)
```
