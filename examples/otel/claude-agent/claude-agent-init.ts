/**
 * Claude Agent SDK + `introspection.init()` one-liner.
 *
 * The Claude Agent SDK is traced by wrapping its module. `init()` discovers
 * `@anthropic-ai/claude-agent-sdk` and binds the wrapper to the shared config;
 * call `introspection.instrumentClaudeAgent(sdk)` to get the traced module —
 * the equivalent of the standalone `withIntrospection(sdk)`.
 *
 * Run with: pnpm claude-agent-init
 *
 * Required env vars:
 *   ANTHROPIC_API_KEY    - Anthropic API key (or authenticated Claude Code)
 *   INTROSPECTION_TOKEN  - Introspection API token
 */

import * as sdk from "@anthropic-ai/claude-agent-sdk";
import * as introspection from "@introspection-sdk/introspection-node/otel";

async function main() {
  await introspection.init({ serviceName: "claude-agent-init" });

  const tracedSdk = introspection.instrumentClaudeAgent(sdk);

  const stream = tracedSdk.query({
    prompt:
      "Write a one-line Python function that returns the square of a number.",
    options: { maxTurns: 1 },
  }) as AsyncIterable<Record<string, unknown>>;

  for await (const message of stream) {
    if (message.type === "assistant") {
      const content = (message as { message?: { content?: unknown[] } }).message
        ?.content;
      for (const block of (content ?? []) as Array<{
        type: string;
        text?: string;
      }>) {
        if (block.type === "text" && block.text)
          process.stdout.write(block.text);
      }
    } else if (message.type === "result") {
      console.log("\n--- done ---");
    }
  }

  await introspection.shutdown();
  console.log("✓ Exported to Introspection.");
}

main().catch(console.error);
