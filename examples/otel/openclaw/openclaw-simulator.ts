/**
 * OpenClaw Plugin Simulator Example
 *
 * `@introspection-sdk/introspection-openclaw` is loaded by the OpenClaw
 * gateway from `~/.openclaw/extensions/` — it's not a library you import.
 * For a fully real run, follow the install steps in the package's README.
 *
 * This example takes the second-best route: it constructs the same
 * `PluginApi` shape the gateway provides, calls the plugin's `register()`,
 * and manually fires the lifecycle hooks with realistic payloads.
 *
 * That exercises every code path in the plugin (span creation, attribute
 * builders, multi-span tool turns, agent finalisation) and exports real
 * spans through the configured OTel pipeline — no OpenClaw install needed.
 *
 * Run with: pnpm openclaw-simulator
 *
 * Required env:
 *   INTROSPECTION_TOKEN
 *
 * Optional:
 *   INTROSPECTION_BASE_OTEL_URL  (default: https://otel.introspection.dev)
 */

import register from "@introspection-sdk/introspection-openclaw";

interface PluginApi {
  pluginConfig: Record<string, unknown>;
  logger: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
  on(hook: string, handler: (event: unknown, ctx: unknown) => void): void;
  registerService(svc: {
    id: string;
    start: () => void;
    stop: () => Promise<void>;
  }): void;
}

type HookHandler = (event: unknown, ctx: unknown) => void;

async function main() {
  // ── 1. Stand up the plugin against a fake gateway ────────────────────────
  const handlers = new Map<string, HookHandler>();
  let serviceStop: (() => Promise<void>) | undefined;

  const api: PluginApi = {
    pluginConfig: {
      token: process.env.INTROSPECTION_TOKEN ?? "",
      baseUrl:
        process.env.INTROSPECTION_BASE_OTEL_URL ??
        "https://otel.introspection.dev",
      serviceName: "openclaw-simulator-example",
      captureMessageContent: true,
      captureToolInput: true,
      captureToolOutput: true,
      maxCaptureLength: 2048,
    },
    logger: {
      info: (msg) => console.log(`[plugin] ${msg}`),
      warn: (msg) => console.warn(`[plugin] ${msg}`),
      error: (msg) => console.error(`[plugin] ${msg}`),
    },
    on: (hook, handler) => handlers.set(hook, handler),
    registerService: (svc) => {
      svc.start();
      serviceStop = svc.stop;
    },
  };

  register(api);

  if (handlers.size === 0) {
    console.error(
      "Plugin did not register any hooks. Set INTROSPECTION_TOKEN and try again.",
    );
    process.exit(1);
  }

  // ── 2. Drive a single agent session through every hook ───────────────────
  const sessionKey = "demo-session-1";
  const ctx = { sessionKey, agentId: "demo-agent" };

  fire(handlers, "before_agent_start", {}, ctx);
  console.log("=== Turn 1: tool-using LLM call ===");

  // First LLM call: prompts a weather lookup, model decides to call a tool.
  fire(
    handlers,
    "llm_input",
    {
      runId: "run-1",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      systemPrompt: "You are a helpful weather assistant. Be concise.",
      historyMessages: [],
      prompt: "What's the weather in Tokyo?",
    },
    ctx,
  );

  // Tool call.
  fire(
    handlers,
    "before_tool_call",
    { toolName: "get_weather", params: { city: "Tokyo" } },
    { ...ctx, toolName: "get_weather" },
  );
  fire(
    handlers,
    "tool_result_persist",
    { message: "Clear, 25°C" },
    { ...ctx, toolName: "get_weather" },
  );

  // First LLM output — assistant emitted the tool_use block.
  fire(
    handlers,
    "llm_output",
    {
      runId: "run-1",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      usage: { input: 380, output: 42, cacheRead: 0, cacheWrite: 0 },
      lastAssistant: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tool_1",
            name: "get_weather",
            arguments: { city: "Tokyo" },
          },
        ],
        stopReason: "tool_use",
        usage: { cost: { total: 0.0042 } },
      },
    },
    ctx,
  );

  console.log("=== Turn 2: follow-up — model summarizes ===");
  fire(
    handlers,
    "llm_input",
    {
      runId: "run-2",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      systemPrompt: "You are a helpful weather assistant. Be concise.",
      historyMessages: [
        { role: "user", content: "What's the weather in Tokyo?" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "get_weather",
              arguments: { city: "Tokyo" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tool_1",
          toolName: "get_weather",
          content: [{ type: "text", text: "Clear, 25°C" }],
        },
      ],
      prompt: undefined,
    },
    ctx,
  );

  fire(
    handlers,
    "llm_output",
    {
      runId: "run-2",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      usage: { input: 480, output: 28, cacheRead: 350, cacheWrite: 0 },
      lastAssistant: {
        role: "assistant",
        content: [{ type: "text", text: "It's clear and 25°C in Tokyo." }],
        stopReason: "end_turn",
        usage: { cost: { total: 0.0029 } },
      },
    },
    ctx,
  );

  fire(handlers, "agent_end", { success: true, durationMs: 1234 }, ctx);

  // ── 3. Tear down ─────────────────────────────────────────────────────────
  // agent_end defers the agent-span close to the next tick — give it a moment.
  await new Promise((resolve) => setTimeout(resolve, 50));

  if (serviceStop) await serviceStop();
  console.log(
    "\n✓ Simulated session complete. Spans flushed to Introspection.",
  );
}

function fire(
  handlers: Map<string, HookHandler>,
  hook: string,
  event: unknown,
  ctx: unknown,
): void {
  const handler = handlers.get(hook);
  if (!handler) {
    console.warn(`[example] no handler registered for ${hook}`);
    return;
  }
  handler(event, ctx);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
