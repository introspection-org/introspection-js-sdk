/**
 * Multi-Agent Subagent Example — Anthropic SDK (Baggage propagation)
 *
 * Same scenario as subagents.ts but shows the *elegant* DX:
 *
 *   - One shared Anthropic client + one AnthropicInstrumentor for the whole
 *     process. No per-call SDK construction.
 *   - Per-call agent identity (gen_ai.agent.name / gen_ai.agent.id /
 *     gen_ai.conversation.id) is propagated via OTel baggage using
 *     IntrospectionLogs.withAgent() / .withConversation().
 *   - setupTracing() takes care of registering AsyncLocalStorageContextManager,
 *     the W3C baggage propagator, and the IntrospectionSpanProcessor in one
 *     call. Without the context manager, context.with() silently drops the
 *     context and baggage never reaches span-creation sites.
 *
 * Compare to subagents.ts (manual spans + BasicTracerProvider) to see the
 * boilerplate removed.
 *
 * Run with: pnpm anthropic-subagents
 */

import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";

import {
  AnthropicInstrumentor,
  setupTracing,
  IntrospectionLogs,
} from "@introspection-sdk/introspection-node/otel";

const token = process.env.INTROSPECTION_TOKEN;
if (!token) throw new Error("INTROSPECTION_TOKEN must be set");

// ── One-call setup ─────────────────────────────────────────────────────────
// Registers AsyncLocalStorageContextManager (so context.with() actually
// propagates), the W3C baggage propagator, and a NodeTracerProvider with
// IntrospectionSpanProcessor attached. Returns the provider for shutdown.
const provider = setupTracing({
  serviceName: "anthropic-sdk-subagents-baggage",
});

const introspect = new IntrospectionLogs({
  serviceName: "anthropic-subagents",
});
const client = new Anthropic();
new AnthropicInstrumentor().instrument({ client });

const MODEL = "claude-sonnet-4-6";
const ORCHESTRATOR_CONV_ID = randomUUID();
const RESEARCHER_PRIMES_CONV_ID = randomUUID();
const RESEARCHER_FIB_CONV_ID = randomUUID();

// A ≥1024-token system prompt is required for Anthropic's prompt cache to
// engage. Each repetition of the filler sentence is ~11 BPE tokens; 100
// repetitions ≈ 1109 tokens total — safely above the 1024-token minimum.
// (80 repetitions ≈ 889 tokens, which falls short and silently disables caching.)
const SYSTEM_PROMPT =
  "You are a concise research assistant. " +
  "Answer the user's question in at most two sentences. ".repeat(100);

interface AgentIdentity {
  agentName: string;
  agentId: string;
  conversationId: string;
}

const ORCHESTRATOR: AgentIdentity = {
  agentName: "orchestrator",
  agentId: "orchestrator-main",
  conversationId: ORCHESTRATOR_CONV_ID,
};
const RESEARCHER_PRIMES: AgentIdentity = {
  agentName: "researcher",
  agentId: "researcher-primes",
  conversationId: RESEARCHER_PRIMES_CONV_ID,
};
const RESEARCHER_FIB: AgentIdentity = {
  agentName: "researcher",
  agentId: "researcher-fibonacci",
  conversationId: RESEARCHER_FIB_CONV_ID,
};

interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

async function runAgent(
  id: AgentIdentity,
  prompt: string,
  history: HistoryTurn[] = [],
): Promise<string> {
  // ── The whole point ───────────────────────────────────────────────────────
  // Identity is set via baggage on the active context. The instrumented
  // client.messages.create reads it and stamps the right gen_ai.* attrs on
  // every span — no per-call SDK wrapper, no per-call instrumentor.
  return introspect.withAgent(id.agentName, id.agentId, () =>
    introspect.withConversation(id.conversationId, undefined, async () => {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 256,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [...history, { role: "user" as const, content: prompt }],
      });

      let text = "";
      for (const block of response.content) {
        if (block.type === "text") text += block.text;
      }
      return text;
    }),
  );
}

async function main(): Promise<void> {
  console.log("Multi-Agent Subagent Example — Baggage propagation\n");

  // Phase 1 — orchestrator dispatches.
  const dispatchPrompt =
    "List 2 research tasks: prime numbers and Fibonacci. One bullet each.";
  const plan = await runAgent(ORCHESTRATOR, dispatchPrompt);

  // Phase 2 — two researchers run in parallel. Promise.all preserves
  // per-branch baggage thanks to AsyncLocalStorage.
  const [primes, fib] = await Promise.all([
    runAgent(
      RESEARCHER_PRIMES,
      "Explain primes in 2 sentences + list first 5.",
    ),
    runAgent(
      RESEARCHER_FIB,
      "Explain Fibonacci in 2 sentences + list first 8.",
    ),
  ]);

  // Phase 3 — orchestrator synthesises, sharing the same conversation ID as
  // Phase 1 so the processor links them as turns of one conversation.
  const synthesis = await runAgent(
    ORCHESTRATOR,
    `Synthesise in 2 sentences:\nPrimes: ${primes}\nFibonacci: ${fib}`,
    [
      { role: "user", content: dispatchPrompt },
      { role: "assistant", content: plan },
    ],
  );

  console.log(`\nPlan: ${plan.slice(0, 120)}`);
  console.log(`Primes: ${primes.slice(0, 120)}`);
  console.log(`Fibonacci: ${fib.slice(0, 120)}`);
  console.log(`Synthesis: ${synthesis.slice(0, 160)}`);

  await provider.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
