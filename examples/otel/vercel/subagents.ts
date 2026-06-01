/**
 * Multi-Agent Subagent Example — Vercel AI SDK (native telemetry)
 *
 * Same scenario as anthropic-sdk/subagents-baggage.ts, using the same
 * baggage pattern:
 *
 *   await introspect.withAgent(agentName, agentId, () =>
 *     introspect.withConversation(conversationId, undefined, () =>
 *       generateText({ ..., experimental_telemetry: { isEnabled: true } }),
 *     ),
 *   );
 *
 *   - No integration class. setupTracing() registers
 *     IntrospectionSpanProcessor on the global tracer; the AI SDK uses
 *     that tracer when `experimental_telemetry: { isEnabled: true }` is
 *     set. The processor maps `ai.*` → `gen_ai.*` at onEnd and merges
 *     baggage from the active context.
 *   - Per-call identity flows via OTel baggage. No per-call functionId /
 *     metadata threading required.
 *   - `Promise.all` is safe because `AsyncLocalStorageContextManager`
 *     (installed by `setupTracing`) forks the baggage context per branch.
 *
 * Run with: pnpm ai-sdk-subagents
 */

import {
  setupTracing,
  IntrospectionLogs,
} from "@introspection-sdk/introspection-node/otel";
import { generateText, stepCountIs } from "ai";
import type { ModelMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { randomUUID } from "crypto";

const provider = setupTracing({ serviceName: "ai-sdk-subagents" });
const introspect = new IntrospectionLogs({ serviceName: "ai-sdk-subagents" });

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

async function runAgent(
  id: AgentIdentity,
  prompt: string,
  history: ModelMessage[] = [],
): Promise<{ text: string; responseMessages: ModelMessage[] }> {
  const messages: ModelMessage[] = [
    {
      role: "system",
      content: SYSTEM_PROMPT,
      providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
    },
    ...history,
    { role: "user", content: prompt },
  ];

  return introspect.withAgent(id.agentName, id.agentId, () =>
    introspect.withConversation(id.conversationId, undefined, async () => {
      const result = await generateText({
        model: anthropic("claude-sonnet-4-6"),
        messages,
        stopWhen: stepCountIs(3),
        experimental_telemetry: { isEnabled: true },
      });
      return {
        text: result.text,
        responseMessages: result.response.messages as ModelMessage[],
      };
    }),
  );
}

async function main(): Promise<void> {
  console.log("Multi-Agent Subagent Example — Vercel AI SDK\n");

  const dispatchPrompt =
    "List 2 research tasks: prime numbers and Fibonacci. One bullet each.";
  const { text: plan, responseMessages: planMessages } = await runAgent(
    ORCHESTRATOR,
    dispatchPrompt,
  );

  const [{ text: primes }, { text: fib }] = await Promise.all([
    runAgent(
      RESEARCHER_PRIMES,
      "Explain primes in 2 sentences + list first 5.",
    ),
    runAgent(
      RESEARCHER_FIB,
      "Explain Fibonacci in 2 sentences + list first 8.",
    ),
  ]);

  const { text: synthesis } = await runAgent(
    ORCHESTRATOR,
    `Synthesise in 2 sentences:\nPrimes: ${primes}\nFibonacci: ${fib}`,
    [{ role: "user", content: dispatchPrompt }, ...planMessages],
  );

  console.log(`\nPlan: ${plan.slice(0, 120)}`);
  console.log(`Primes: ${primes.slice(0, 120)}`);
  console.log(`Fibonacci: ${fib.slice(0, 120)}`);
  console.log(`Synthesis: ${synthesis.slice(0, 160)}`);

  await provider.shutdown();
  console.log("Done — spans exported to Introspection.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
