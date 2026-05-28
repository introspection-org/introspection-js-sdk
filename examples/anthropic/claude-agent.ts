/**
 * Claude Agent SDK Example
 *
 * Demonstrates using withIntrospection() to automatically instrument
 * Claude Agent SDK sessions with gen_ai.* OpenTelemetry attributes.
 *
 * The wrapper automatically:
 * - Captures the prompt and system instructions
 * - Records usage from every streamed message (including cache tokens)
 * - Creates session, tool, and subagent spans
 * - Sets gen_ai.conversation.id so multi-turn sessions link correctly
 *
 * Prerequisites:
 * - ANTHROPIC_API_KEY or Claude Code installed and authenticated
 * - INTROSPECTION_TOKEN environment variable
 *
 * Run with: pnpm claude-agent
 */

import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { withIntrospection } from "@introspection-sdk/introspection-node/otel";

if (!process.env.INTROSPECTION_TOKEN) {
  throw new Error("INTROSPECTION_TOKEN must be set");
}

async function main() {
  console.log("Initializing Claude Agent SDK with Introspection tracking...\n");

  const tracedSdk = withIntrospection(sdk, {
    serviceName: "claude-agent-example",
  });

  // System prompt is required for gen_ai.system_instructions to appear in spans.
  // It must be ≥1024 tokens for Anthropic's prompt caching to activate on the
  // first turn (cache_creation_input_tokens > 0) and produce cache reads on
  // the second turn (cache_read_input_tokens > 0).
  const systemPrompt = `You are an expert software engineer and coding assistant with deep knowledge of algorithms, data structures, software design patterns, and best practices across multiple programming languages including Python, TypeScript, JavaScript, Go, and Rust.

Your primary responsibility is to write clean, well-documented, and efficient code. Always include docstrings, type hints, and example usage. When writing Python, follow PEP 8. When writing TypeScript or JavaScript, follow ESLint best practices and prefer const over let.

Always explain your reasoning and walk through logic step by step. Structure responses clearly: implementation first, then explanation. Mention edge cases and performance considerations proactively.

## Algorithms and data structures

When asked about algorithms, analyse time and space complexity using Big-O notation. Explain trade-offs between approaches. For sorting: know when to use quicksort (average O(n log n), in-place), mergesort (stable, O(n log n)), heapsort (guaranteed O(n log n)), or radix sort (O(nk) for integers). For searching: prefer binary search (O(log n)) over linear search (O(n)) whenever the data is sorted.

Common data structure choices:
- Array / slice: random access O(1), append amortised O(1), insert/delete O(n)
- Linked list: insert/delete at head O(1), random access O(n); prefer when frequent mid-list mutation
- Hash map: average O(1) lookup, insert, delete; worst-case O(n) on collision
- Balanced BST / sorted set: O(log n) operations, maintains order; use when you need both lookup and ordered traversal
- Heap / priority queue: O(log n) push/pop, O(1) peek; use for scheduling, Dijkstra, top-k problems
- Trie: O(m) operations where m is key length; use for prefix search, autocomplete, spell check
- Union-Find (Disjoint Set): near O(1) amortised union and find with path compression; use for connectivity

## Design patterns

Apply design patterns judiciously. Common patterns and when to use them:
- Strategy: swap algorithms at runtime (sorting strategies, payment processors)
- Observer: decouple producers from consumers (event buses, reactive state)
- Factory / Abstract Factory: encapsulate object creation, avoid tight coupling to concrete types
- Decorator: add behaviour without subclassing (middleware pipelines, I/O streams)
- Repository: abstract data access behind an interface to keep business logic testable
- Command: encapsulate operations for undo/redo, queuing, or logging
- Singleton: use sparingly; prefer dependency injection to avoid hidden global state

## Code quality standards

Write code that is easy to test and maintain. Prefer pure functions. Avoid side effects in business logic; push I/O to the edges. Follow the single-responsibility principle — each function or class should have exactly one reason to change.

Naming: use descriptive, intent-revealing names. Avoid abbreviations unless universally understood (e.g., i for loop indices, err for errors in Go). Function names should be verbs (calculateTax, fetchUser); type/class names should be nouns (Invoice, UserRepository).

Error handling: validate at boundaries (user input, external APIs, file I/O). Trust internal invariants. Return structured errors with context rather than bare strings. Never silently swallow exceptions.

Testing: cover happy paths and edge cases. Name tests descriptively: test_should_return_empty_list_when_no_items_match. Mock only at I/O boundaries. Prefer integration tests over unit tests when the logic is simple and the integration is complex.

Performance: profile before optimising. Favour algorithmic improvements over micro-optimisations. Cache expensive computations. Avoid N+1 queries by batching database calls.

Security: sanitise all user input. Never concatenate SQL strings — use parameterised queries. Hash passwords with bcrypt or argon2; never store plaintext. Use HTTPS. Apply least-privilege principle to API keys and service accounts.

Always call the relevant tool first if one is available before answering a question that requires live data or file system access. Never fabricate results.`;

  try {
    const stream = tracedSdk.query({
      prompt:
        "Write a Python function that checks whether a number is prime. Include a brief docstring and a few example calls showing it works.",
      options: {
        maxTurns: 3,
        systemPrompt,
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
          | {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            }
          | undefined;
        if (usage) {
          console.log(
            `Tokens: ${usage.input_tokens || 0} input, ${usage.output_tokens || 0} output`,
          );
          if (usage.cache_read_input_tokens) {
            console.log(`Cache Read: ${usage.cache_read_input_tokens} tokens`);
          }
          if (usage.cache_creation_input_tokens) {
            console.log(
              `Cache Write: ${usage.cache_creation_input_tokens} tokens`,
            );
          }
        }

        // modelUsage has per-model cache breakdown when top-level usage omits it
        const modelUsage = message.modelUsage as
          | Record<
              string,
              {
                inputTokens?: number;
                outputTokens?: number;
                cacheReadInputTokens?: number;
                cacheCreationInputTokens?: number;
                costUSD?: number;
              }
            >
          | undefined;
        if (modelUsage) {
          let totalCacheRead = 0;
          let totalCacheCreation = 0;
          for (const [model, data] of Object.entries(modelUsage)) {
            totalCacheRead += data.cacheReadInputTokens || 0;
            totalCacheCreation += data.cacheCreationInputTokens || 0;
            console.log(
              `  [${model}] in=${data.inputTokens || 0} out=${data.outputTokens || 0} cacheRead=${data.cacheReadInputTokens || 0} cacheWrite=${data.cacheCreationInputTokens || 0} cost=$${(data.costUSD || 0).toFixed(6)}`,
            );
          }
          if (totalCacheRead > 0 || totalCacheCreation > 0) {
            console.log(
              `Cache totals — Read: ${totalCacheRead}, Write: ${totalCacheCreation}`,
            );
          }
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
      "\nDone! Check Introspection for the instrumented session span.",
    );
    console.log("  Attributes captured:");
    console.log("  - gen_ai.input.messages, gen_ai.output.messages");
    console.log("  - gen_ai.usage.input_tokens, gen_ai.usage.output_tokens");
    console.log(
      "  - gen_ai.usage.cache_read.input_tokens, gen_ai.usage.cache_creation.input_tokens",
    );
    console.log("  - gen_ai.conversation.id (links turns in processor)");
    console.log("  - gen_ai.request.model, gen_ai.system, gen_ai.cost.usd");
  } finally {
    await tracedSdk.shutdown();
  }
}

main().catch(console.error);
