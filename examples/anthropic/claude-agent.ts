/**
 * Claude Agent SDK Example
 *
 * Demonstrates using withIntrospection() to automatically instrument
 * Claude Agent SDK sessions with gen_ai.* OpenTelemetry attributes.
 *
 * The wrapper automatically:
 * - Captures the prompt and system instructions
 * - Records usage from every streamed message
 * - Creates session, tool, and subagent spans
 *
 * Prerequisites:
 * - ANTHROPIC_API_KEY or Claude Code installed and authenticated
 * - INTROSPECTION_TOKEN environment variable
 *
 * Run with: pnpm claude-agent
 */

import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { withIntrospection } from "@introspection-sdk/introspection-node";

if (!process.env.INTROSPECTION_TOKEN) {
  throw new Error("INTROSPECTION_TOKEN must be set");
}

async function main() {
  console.log("Initializing Claude Agent SDK with Introspection tracking...\n");

  const tracedSdk = withIntrospection(sdk, {
    serviceName: "claude-agent-example",
  });

  try {
    const stream = tracedSdk.query({
      prompt: "What is 2 + 2? Just give me the number.",
      options: {
        maxTurns: 1,
      },
    }) as AsyncIterable<Record<string, unknown>>;

    console.log("Streaming response from Claude Agent SDK:\n");

    for await (const message of stream) {
      if (message.type === "system" && message.subtype === "init") {
        console.log(
          `[Session started] ID: ${message.session_id}, Model: ${message.model}`,
        );
      } else if (message.type === "assistant") {
        const content = (message as { message?: { content?: unknown[] } })
          .message?.content;
        if (content) {
          for (const block of content as Array<{
            type: string;
            text?: string;
          }>) {
            if (block.type === "text" && block.text) {
              process.stdout.write(block.text);
            }
          }
        }
      } else if (message.type === "result") {
        console.log("\n\n--- Result ---");
        if (message.result) {
          console.log(`Output: ${message.result}`);
        }
        const usage = message.usage as
          | { input_tokens?: number; output_tokens?: number }
          | undefined;
        if (usage) {
          console.log(
            `Tokens: ${usage.input_tokens || 0} input, ${usage.output_tokens || 0} output`,
          );
        }
        if (message.total_cost_usd !== undefined) {
          console.log(
            `Cost: $${(message.total_cost_usd as number).toFixed(6)}`,
          );
        }
        if (message.is_error) {
          console.log("(Error occurred)");
        }
      }
    }

    // Spans are auto-flushed when the stream completes.
    // Give batch processor time to finish export.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    console.log(
      "\nDone! Check the Introspection backend for the instrumented spans:",
    );
    console.log("  - gen_ai.input.messages (input in semconv format)");
    console.log("  - gen_ai.output.messages (response in semconv format)");
    console.log("  - gen_ai.usage.input_tokens, gen_ai.usage.output_tokens");
    console.log("  - gen_ai.request.model, gen_ai.system, gen_ai.cost.usd");
  } finally {
    await tracedSdk.shutdown();
  }
}

main().catch(console.error);
