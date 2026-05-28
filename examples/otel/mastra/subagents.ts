/**
 * Multi-Agent Subagent Example — Mastra
 *
 * Same scenario as anthropic-sdk/subagents-baggage.ts, built on Mastra.
 *
 * Per-call identity:
 *   - `gen_ai.agent.name` ← `Agent.name` (Mastra exporter maps entityName)
 *   - `gen_ai.conversation.id` ← `tracingOptions.metadata["gen_ai.conversation.id"]`
 *
 * Why not OTel baggage like the other examples?
 *
 *   Mastra's exporter is **deferred**: span events arrive after the user's
 *   call has already returned, so by the time `_exportTracingEvent` runs the
 *   user's OTel baggage context is no longer active. Mastra instead carries
 *   identity via its own `tracingOptions.metadata` channel, which the
 *   IntrospectionMastraExporter reads when converting Mastra spans → OTel.
 *
 *   For frameworks that emit OTel spans live (Anthropic SDK, Pi, LangChain,
 *   Vercel AI SDK), use `introspect.withGenAi({ ... }, fn)` instead.
 *
 * Run with: pnpm mastra-subagents
 */

import { Mastra } from "@mastra/core";
import { Agent } from "@mastra/core/agent";
import { Observability } from "@mastra/observability";
import { IntrospectionMastraExporter } from "@introspection-sdk/introspection-node/mastra";
import { anthropic } from "@ai-sdk/anthropic";
import { randomUUID } from "crypto";

const token = process.env.INTROSPECTION_TOKEN;
if (!token) throw new Error("INTROSPECTION_TOKEN must be set");

const observability = new Observability({
  configs: {
    otel: {
      serviceName: "mastra-subagents",
      exporters: [new IntrospectionMastraExporter()],
    },
  },
});

const mastra = new Mastra({ observability });

// ≥1024-token system prompt for Anthropic prompt cache (100 reps ≈ 1109 tok).
const SYSTEM_PROMPT =
  "You are a concise research assistant. " +
  "Answer the user's question in at most two sentences. ".repeat(100);

const SYSTEM_MESSAGE = {
  role: "system" as const,
  content: SYSTEM_PROMPT,
  providerOptions: {
    anthropic: { cacheControl: { type: "ephemeral" as const } },
  },
};

// ── Agents ─────────────────────────────────────────────────────────────────
// Agent.name → gen_ai.agent.name. The two researcher conversations reuse the
// same Agent because they share a role; identity is differentiated solely
// by the conversationId passed in tracingOptions.metadata.
const orchestratorAgent = new Agent({
  id: "orchestrator",
  name: "orchestrator",
  instructions: "You are a research orchestrator.",
  model: anthropic("claude-sonnet-4-6"),
  mastra,
});

const researcherAgent = new Agent({
  id: "researcher",
  name: "researcher",
  instructions: "You are a concise research assistant.",
  model: anthropic("claude-sonnet-4-6"),
  mastra,
});

const ORCHESTRATOR_CONV_ID = randomUUID();
const RESEARCHER_PRIMES_CONV_ID = randomUUID();
const RESEARCHER_FIB_CONV_ID = randomUUID();

type HistoryMessage = { role: "user" | "assistant"; content: string };

async function runAgent(
  agent: Agent,
  conversationId: string,
  prompt: string,
  history: HistoryMessage[] = [],
): Promise<string> {
  const messages = [
    SYSTEM_MESSAGE,
    ...history,
    { role: "user" as const, content: prompt },
  ];
  const result = await agent.generate(messages, {
    tracingOptions: { metadata: { "gen_ai.conversation.id": conversationId } },
  });
  return result.text;
}

async function main(): Promise<void> {
  console.log("Multi-Agent Subagent Example — Mastra\n");

  // Phase 1 — orchestrator dispatches.
  const dispatchPrompt =
    "List 2 research tasks: prime numbers and Fibonacci. One bullet each.";
  const plan = await runAgent(
    orchestratorAgent,
    ORCHESTRATOR_CONV_ID,
    dispatchPrompt,
  );

  // Phase 2 — two researchers run in parallel. Each call gets its own Mastra
  // traceId, so spans on the shared researcherAgent stay isolated.
  const [primes, fib] = await Promise.all([
    runAgent(
      researcherAgent,
      RESEARCHER_PRIMES_CONV_ID,
      "Explain primes in 2 sentences + list first 5.",
    ),
    runAgent(
      researcherAgent,
      RESEARCHER_FIB_CONV_ID,
      "Explain Fibonacci in 2 sentences + list first 8.",
    ),
  ]);

  // Phase 3 — orchestrator synthesises, reusing ORCHESTRATOR_CONV_ID.
  const synthesis = await runAgent(
    orchestratorAgent,
    ORCHESTRATOR_CONV_ID,
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

  await observability.shutdown();
  console.log("Done — spans exported to Introspection.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
