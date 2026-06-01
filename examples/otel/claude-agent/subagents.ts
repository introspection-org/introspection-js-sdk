/**
 * Multi-Agent Subagent Example — Claude Agent SDK
 *
 * Same scenario as anthropic-sdk/subagents-baggage.ts, using the same
 * baggage pattern:
 *
 *   await introspect.withAgent(agentName, agentId, () =>
 *     introspect.withConversation(conversationId, undefined, () =>
 *       tracedSdk.query({ ... }),
 *     ),
 *   );
 *
 *   - One shared `withIntrospection()` for the whole process — no per-agent
 *     instrumented SDK instances.
 *   - Per-call identity flows via OTel baggage. `IntrospectionClaudeHooks`
 *     resolves `gen_ai.agent.name` / `gen_ai.agent.id` /
 *     `gen_ai.conversation.id` from active baggage when a session starts
 *     (see `_resolveIdentity`), falling back to the constructor options or
 *     the Claude session ID.
 *   - `Promise.all` is safe because `AsyncLocalStorageContextManager`
 *     (installed by `setupTracing`) forks the baggage context per branch.
 *
 * Prerequisites:
 *   - ANTHROPIC_API_KEY or Claude Code installed and authenticated
 *   - INTROSPECTION_TOKEN environment variable
 *
 * Run with: pnpm claude-agent-subagents
 */

import * as sdk from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "crypto";
import {
  setupTracing,
  IntrospectionLogs,
  withIntrospection,
} from "@introspection-sdk/introspection-node/otel";

if (!process.env.INTROSPECTION_TOKEN) {
  throw new Error("INTROSPECTION_TOKEN must be set");
}

// setupTracing installs the AsyncLocalStorageContextManager + W3C baggage
// propagator that withGenAi() relies on. Without it, context.with() is a
// no-op and identity never reaches the Claude hooks.
setupTracing({ serviceName: "claude-agent-subagents" });

const introspect = new IntrospectionLogs({
  serviceName: "claude-agent-subagents",
});
const tracedSdk = withIntrospection(sdk, {
  serviceName: "claude-agent-subagents",
});

interface AgentIdentity {
  agentName: string;
  agentId: string;
  conversationId: string;
}

const ORCHESTRATOR: AgentIdentity = {
  agentName: "orchestrator",
  agentId: "orchestrator-main",
  conversationId: randomUUID(),
};
const RESEARCHER_PRIMES: AgentIdentity = {
  agentName: "researcher",
  agentId: "researcher-primes",
  conversationId: randomUUID(),
};
const RESEARCHER_FIB: AgentIdentity = {
  agentName: "researcher",
  agentId: "researcher-fibonacci",
  conversationId: randomUUID(),
};

// ≥1024-token system prompt for Anthropic's prompt cache (80 reps ≈ 889 tok,
// 100 reps ≈ 1109 tok — the latter is above the 1024-token minimum).
const SYSTEM_PROMPT =
  "You are a concise research assistant. " +
  "Answer the user's question in at most two sentences. ".repeat(100);

async function runAgent(id: AgentIdentity, prompt: string): Promise<string> {
  return introspect.withAgent(id.agentName, id.agentId, () =>
    introspect.withConversation(id.conversationId, undefined, async () => {
      const stream = tracedSdk.query({
        prompt,
        options: { maxTurns: 1, systemPrompt: SYSTEM_PROMPT },
      }) as AsyncIterable<Record<string, unknown>>;

      let result = "";
      for await (const message of stream) {
        if (message.type !== "assistant") continue;
        const content = (message as { message?: { content?: unknown[] } })
          .message?.content;
        if (!content) continue;
        for (const block of content as Array<{ type: string; text?: string }>) {
          if (block.type === "text" && block.text) result += block.text;
        }
      }
      return result;
    }),
  );
}

async function main(): Promise<void> {
  console.log("Multi-Agent Subagent Example — Claude Agent SDK\n");

  // Phase 1 — orchestrator dispatches.
  const plan = await runAgent(
    ORCHESTRATOR,
    "List 2 research tasks: prime numbers and Fibonacci. One bullet each.",
  );

  // Phase 2 — two researchers in parallel. Each branch has its own baggage
  // thanks to AsyncLocalStorageContextManager.
  const [primes, fib] = await Promise.all([
    runAgent(
      RESEARCHER_PRIMES,
      "Explain primes in 2 sentences + list the first 5.",
    ),
    runAgent(
      RESEARCHER_FIB,
      "Explain Fibonacci in 2 sentences + list the first 8 numbers.",
    ),
  ]);

  // Phase 3 — orchestrator synthesises, sharing Phase 1's conversationId.
  const synthesis = await runAgent(
    ORCHESTRATOR,
    `Synthesise in 2 sentences:\nPrimes: ${primes}\nFibonacci: ${fib}`,
  );

  console.log(`\nPlan: ${plan.slice(0, 120)}`);
  console.log(`Primes: ${primes.slice(0, 120)}`);
  console.log(`Fibonacci: ${fib.slice(0, 120)}`);
  console.log(`Synthesis: ${synthesis.slice(0, 160)}`);

  await tracedSdk.shutdown();
  console.log("Done — spans exported to Introspection.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
