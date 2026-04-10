# Tests Package

Integration tests for the introspection SDK, ported from the stream-client project.

## Setup

```bash
# Copy and fill in env vars
cp .env.example .env

# Install dependencies
pnpm install

# Run all tests
pnpm test
```

## Structure

### Test Utilities

- **fixtures.ts** - `CaptureTracingProcessor` fixture for OpenAI Agents SDK tests
- **testing.ts** - `IncrementalIdGenerator`, `TestSpanExporter`, and snapshot helpers

### Processor Tests

- **processors/tracing-processor.test.ts** - Tests `IntrospectionTracingProcessor` with OpenAI Agents SDK

### Observability Dual-Export Tests

Tests that verify spans are correctly exported to both a third-party observability platform and Introspection simultaneously:

| Test File                               | Platforms                             |
| --------------------------------------- | ------------------------------------- |
| `observability/test-arize.test.ts`      | Arize + Introspection                 |
| `observability/test-braintrust.test.ts` | Braintrust + Introspection            |
| `observability/test-langfuse.test.ts`   | Langfuse + Introspection              |
| `observability/test-langchain.test.ts`  | LangSmith + Introspection             |
| `observability/test-vercel.test.ts`     | Vercel AI SDK + Arize + Introspection |

## Environment Variables

See `.env.example` for all required variables. At minimum you need:

```
OPENAI_API_KEY=sk-...
INTROSPECTION_TOKEN=your-token
```

Additional variables are needed for specific observability platform tests.

## Running Specific Tests

```bash
# Run only processor tests
pnpm test:processors

# Run only observability tests
pnpm test:observability

# Run in watch mode
pnpm test:watch
```
