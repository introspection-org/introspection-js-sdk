# introspection-openclaw

OpenClaw plugin for [Introspection](https://introspection.dev) — captures agent lifecycle spans so Introspection can analyze and improve your AI system. Exports using OTEL Gen AI semantic conventions.

## What it does

Hooks into 6 OpenClaw lifecycle events and produces a span hierarchy per agent session:

```
invoke_agent my-agent               (root, cumulative tokens)
  ├── gen_ai.chat anthropic          (LLM call 1)
  ├── execute_tool Read              (tool call 1)
  ├── gen_ai.chat anthropic          (LLM call 2)
  └── execute_tool Write             (tool call 2)
```

All spans follow the [OTEL Gen AI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/) — `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.usage.*`, `gen_ai.tool.*`, etc.

## Setup

### 1. Build

```bash
pnpm --filter @introspection-sdk/introspection-openclaw build
```

### 2. Install into OpenClaw

OpenClaw loads plugins from `~/.openclaw/extensions/`. Copy the built package there:

```bash
mkdir -p ~/.openclaw/extensions/introspection-openclaw

# Copy plugin manifest and built output
cp packages/introspection-openclaw/openclaw.plugin.json ~/.openclaw/extensions/introspection-openclaw/
cp packages/introspection-openclaw/package.json ~/.openclaw/extensions/introspection-openclaw/
cp -R packages/introspection-openclaw/dist ~/.openclaw/extensions/introspection-openclaw/dist

# Install production dependencies
cd ~/.openclaw/extensions/introspection-openclaw && npm install --omit=dev
```

> **Note:** OpenClaw does not follow symlinks — you must copy the files.

### 3. Configure `~/.openclaw/openclaw.json`

Add the plugin to the allow list and configure it:

```jsonc
{
  "plugins": {
    "allow": [
      // ... existing plugins ...
      "introspection-openclaw",
    ],
    "entries": {
      // ... existing entries ...
      "introspection-openclaw": {
        "enabled": true,
        "config": {
          "token": "<your-introspection-token>",
          "baseUrl": "https://otel.introspection.dev",
        },
      },
    },
  },
}
```

The token can also be set via the `INTROSPECTION_TOKEN` environment variable.

### 4. Restart the gateway

```bash
openclaw gateway stop && openclaw gateway install
```

### 5. Verify

```bash
openclaw plugins list
```

You should see `introspection-openclaw` listed as loaded. Run an agent session and check your Introspection dashboard for incoming spans.

## Configuration

All config options can be set in `plugins.entries.introspection-openclaw.config` or via environment variables:

| Config key              | Env var                      | Default                          | Description                                          |
| ----------------------- | ---------------------------- | -------------------------------- | ---------------------------------------------------- |
| `token`                 | `INTROSPECTION_TOKEN`        | —                                | **Required.** Introspection write token.             |
| `baseUrl`               | `INTROSPECTION_BASE_URL`     | `https://otel.introspection.dev` | OTLP endpoint URL.                                   |
| `serviceName`           | `INTROSPECTION_SERVICE_NAME` | `openclaw-agent`                 | OTEL service name.                                   |
| `captureMessageContent` | —                            | `true`                           | Record LLM prompt/response content.                  |
| `captureToolInput`      | —                            | `true`                           | Record tool call arguments.                          |
| `captureToolOutput`     | —                            | `true`                           | Record tool results.                                 |
| `maxCaptureLength`      | —                            | `2048`                           | Max character length for captured tool input/output. |

## Exported span attributes

### Agent span (`invoke_agent`)

- `gen_ai.operation.name` = `"invoke_agent"`
- `gen_ai.agent.name`, `gen_ai.agent.id`
- `gen_ai.conversation.id`
- `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.provider.name`
- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` (cumulative)
- `openclaw.usage.cache_read_tokens`, `openclaw.usage.cache_write_tokens`
- `openclaw.request.duration_ms`, `openclaw.request.tool_count`

### LLM span (`gen_ai.chat`)

- `gen_ai.operation.name` = `"chat"`
- `gen_ai.request.model`, `gen_ai.response.model`, `gen_ai.provider.name`
- `gen_ai.system_instructions` — system prompt in OTEL parts format
- `gen_ai.system` — provider name (e.g. `"anthropic"`)
- `gen_ai.input.messages` — conversation history + current prompt in `{role, parts}` format
- `gen_ai.output.messages` — assistant response in `{role, parts, finish_reason}` format
- `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`
- `gen_ai.response.finish_reasons`
- `gen_ai.cost.usd`

### Tool span (`execute_tool`)

- `gen_ai.operation.name` = `"execute_tool"`
- `gen_ai.tool.name`, `gen_ai.tool.type` = `"function"`
- `gen_ai.tool.input` — tool call arguments (truncated to `maxCaptureLength`)
- `gen_ai.tool.output` — tool result (truncated to `maxCaptureLength`)
- `openclaw.tool.sequence`, `openclaw.tool.duration_ms`
- `openclaw.tool.input_size`, `openclaw.tool.output_size`
