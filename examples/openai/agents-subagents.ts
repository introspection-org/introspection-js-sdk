/**
 * Multi-Agent Subagent Example — OpenAI Agents SDK (withTrace + groupId)
 *
 * Same 3-phase research scenario as anthropic-sdk/subagents-baggage.ts but
 * built on the OpenAI Agents SDK:
 *
 *   - One IntrospectionTracingProcessor for the whole process.
 *   - Per-agent conversation identity is controlled via withTrace() groupId:
 *     · The orchestrator wraps phases 1 & 3 in one withTrace (same groupId)
 *       so both turns land in the same conversation.
 *     · Each researcher gets its own withTrace with a distinct groupId.
 *   - Promise.all runs the two researchers in parallel; each withTrace forks
 *     the async context so spans don't cross-contaminate.
 *   - gen_ai.agent.name comes from Agent({ name: "..." }) — already in the
 *     OpenAI span data, no OTel baggage needed.
 *
 * How groupId becomes gen_ai.conversation.id:
 *   IntrospectionTracingProcessor.onTraceStart reads trace.groupId and uses it
 *   as the conversation ID instead of auto-generating one. All spans under a
 *   trace inherit that conversation ID via _conversationIds[trace.traceId].
 *
 * Compare to anthropic-sdk/subagents-baggage.ts (OTel baggage approach) to
 * see the OpenAI SDK's native trace grouping alternative.
 *
 * Prompt caching:
 *   Agents use OpenAIChatCompletionsModel (Chat Completions API) which supports
 *   cross-request prefix caching: identical prompt prefixes are cached
 *   automatically. Phase 3 hits the cache written by phase 1 (same 1.1k
 *   instructions prefix), visible as gen_ai.usage.cache_read.input_tokens > 0.
 *   The Chat Completions API reports cache reads via
 *   prompt_tokens_details.cached_tokens. Note: the Responses API (default model)
 *   does NOT support cross-request prefix caching — only Chat Completions does.
 *
 * Run with: pnpm openai-agents-subagents
 */

import {
  Agent,
  run,
  addTraceProcessor,
  withTrace,
  OpenAIChatCompletionsModel,
} from "@openai/agents";
import { IntrospectionTracingProcessor } from "@introspection-sdk/introspection-node/otel";
import OpenAI from "openai";
import { randomUUID } from "crypto";

const token = process.env.INTROSPECTION_TOKEN;
if (!token) throw new Error("INTROSPECTION_TOKEN must be set");

const processor = new IntrospectionTracingProcessor({
  serviceName: "openai-agents-subagents",
});
addTraceProcessor(processor);

const openai = new OpenAI();

// ── Shared instructions ───────────────────────────────────────────────────────
// A ≥1024-token system prompt is required for OpenAI's automatic prefix cache
// to engage on the Chat Completions API. Each sentence repetition is ~10
// tokens; 110 repetitions ≈ 1100 tokens — safely above the 1024-token minimum.
const RESEARCHER_INSTRUCTIONS =
  "You are a concise research assistant. " +
  "Answer the user's question in at most two sentences. ".repeat(110);

const ORCHESTRATOR_INSTRUCTIONS =
  "You are a concise orchestrator that dispatches research tasks and synthesizes results. " +
  "Keep all responses to at most two sentences. ".repeat(110);

// ── Agent instances ───────────────────────────────────────────────────────────
// OpenAIChatCompletionsModel(client, modelName) uses the Chat Completions API,
// which supports cross-request prefix caching (unlike the Responses API).
// Agent.name → gen_ai.agent.name on every agent span.
const orchestratorAgent = new Agent({
  name: "orchestrator",
  model: new OpenAIChatCompletionsModel(openai, "gpt-4o-mini"),
  instructions: ORCHESTRATOR_INSTRUCTIONS,
});

const primesAgent = new Agent({
  name: "researcher",
  model: new OpenAIChatCompletionsModel(openai, "gpt-4o-mini"),
  instructions: RESEARCHER_INSTRUCTIONS,
});

const fibAgent = new Agent({
  name: "researcher",
  model: new OpenAIChatCompletionsModel(openai, "gpt-4o-mini"),
  instructions: RESEARCHER_INSTRUCTIONS,
});

// ── Conversation IDs ──────────────────────────────────────────────────────────
// Passed as withTrace groupId → IntrospectionTracingProcessor uses them as
// gen_ai.conversation.id instead of auto-generating one per trace.
// The orchestrator reuses its ID across phases 1 & 3 to link them as one
// multi-turn conversation.
const ORCHESTRATOR_CONV_ID = randomUUID();
const RESEARCHER_PRIMES_CONV_ID = randomUUID();
const RESEARCHER_FIB_CONV_ID = randomUUID();

async function main(): Promise<void> {
  console.log("Multi-Agent Subagent Example — OpenAI Agents SDK\n");

  let plan = "";
  let primes = "";
  let fib = "";
  let synthesis = "";

  // The orchestrator's two run() calls share a withTrace context (same groupId)
  // → same gen_ai.conversation.id. Phase 2 researcher calls live in nested
  // withTrace blocks so each gets its own trace and conversation ID.
  await withTrace(
    "orchestrator-conversation",
    async () => {
      // Phase 1 — orchestrator dispatches.
      const dispatchPrompt =
        "List 2 research tasks: prime numbers and Fibonacci. One bullet each.";
      const r1 = await run(orchestratorAgent, dispatchPrompt);
      plan = r1.finalOutput ?? "";

      // Phase 2 — two researchers run in parallel.
      // Each nested withTrace forks the async context: their run() calls see
      // the researcher trace, not the outer orchestrator trace.
      [primes, fib] = await Promise.all([
        withTrace(
          "researcher-primes",
          async () => {
            const r = await run(
              primesAgent,
              "Explain primes in 2 sentences + list first 5.",
            );
            return r.finalOutput ?? "";
          },
          { groupId: RESEARCHER_PRIMES_CONV_ID },
        ),
        withTrace(
          "researcher-fib",
          async () => {
            const r = await run(
              fibAgent,
              "Explain Fibonacci in 2 sentences + list first 8.",
            );
            return r.finalOutput ?? "";
          },
          { groupId: RESEARCHER_FIB_CONV_ID },
        ),
      ]);

      // Phase 3 — orchestrator synthesises inside the outer withTrace context
      // → same conversationId as phase 1. The shared instructions prefix hits
      // the prompt cache written by phase 1 → cache_read.input_tokens > 0.
      const r3 = await run(
        orchestratorAgent,
        `Synthesise in 2 sentences:\nPrimes: ${primes}\nFibonacci: ${fib}`,
      );
      synthesis = r3.finalOutput ?? "";
    },
    { groupId: ORCHESTRATOR_CONV_ID },
  );

  console.log(`\nPlan: ${plan.slice(0, 120)}`);
  console.log(`Primes: ${primes.slice(0, 120)}`);
  console.log(`Fibonacci: ${fib.slice(0, 120)}`);
  console.log(`Synthesis: ${synthesis.slice(0, 160)}`);

  await processor.shutdown();
}

// The OpenAI Agents SDK installs a `beforeExit` handler that re-invokes
// shutdown() with a 5s timeout. Under CI network conditions the exporter
// flush often exceeds that and the SDK force-exits with code 1. Bypass
// the natural-exit path by exiting cleanly ourselves.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
