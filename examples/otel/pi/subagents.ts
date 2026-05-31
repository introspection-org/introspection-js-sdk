/**
 * Multi-Agent Subagent Example — Pi Agent SDK (Baggage propagation)
 *
 * Same scenario as anthropic-sdk/subagents-baggage.ts but built on
 * `@mariozechner/pi-agent-core`:
 *
 *   - setupTracing() + IntrospectionPiInstrumentor handle all OTel setup.
 *   - Each agent role gets its own pi Agent instance with independent state.
 *   - Per-call agent identity (gen_ai.agent.name / gen_ai.agent.id /
 *     gen_ai.conversation.id) is propagated via OTel baggage using
 *     IntrospectionClient.withAgent() / .withConversation().
 *   - Promise.all preserves per-branch baggage thanks to AsyncLocalStorage.
 *
 * Run with: pnpm pi-subagents
 *
 * Required env:
 *   INTROSPECTION_TOKEN   ANTHROPIC_API_KEY
 */

import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { randomUUID } from "crypto";
import { IntrospectionClient } from "@introspection-sdk/introspection-node";
import {
  IntrospectionPiInstrumentor,
  setupTracing,
  type PiAgentMeta,
} from "@introspection-sdk/introspection-node/otel";

const token = process.env.INTROSPECTION_TOKEN;
if (!token) throw new Error("INTROSPECTION_TOKEN must be set");

const provider = setupTracing({ serviceName: "pi-subagents-baggage" });
const introspect = new IntrospectionClient();
const piInstrumentor = new IntrospectionPiInstrumentor();

const MODEL = getModel("anthropic", "claude-sonnet-4-6");

const SYSTEM_PROMPT =
  "You are a concise research assistant. " +
  "Answer the user's question in at most two sentences. ".repeat(80);

const ORCHESTRATOR: PiAgentMeta = {
  agentName: "orchestrator",
  agentId: "orchestrator-main",
  conversationId: randomUUID(),
};
const RESEARCHER_PRIMES: PiAgentMeta = {
  agentName: "researcher",
  agentId: "researcher-primes",
  conversationId: randomUUID(),
};
const RESEARCHER_FIB: PiAgentMeta = {
  agentName: "researcher",
  agentId: "researcher-fibonacci",
  conversationId: randomUUID(),
};

function makeAgent(meta: PiAgentMeta): Agent {
  const agent = new Agent({
    initialState: { model: MODEL, systemPrompt: SYSTEM_PROMPT, tools: [] },
  });
  piInstrumentor.instrument(agent, meta);
  return agent;
}

const orchestratorAgent = makeAgent(ORCHESTRATOR);
const primesAgent = makeAgent(RESEARCHER_PRIMES);
const fibAgent = makeAgent(RESEARCHER_FIB);

function getLastAssistantText(agent: Agent): string {
  for (let i = agent.state.messages.length - 1; i >= 0; i--) {
    const msg = agent.state.messages[i];
    if (msg && msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "text") return block.text;
      }
    }
  }
  return "";
}

async function runAgent(
  agent: Agent,
  meta: PiAgentMeta,
  prompt: string,
): Promise<string> {
  return introspect.withAgent(meta.agentName, meta.agentId, () =>
    introspect.withConversation(meta.conversationId, undefined, async () => {
      await agent.prompt(prompt);
      return getLastAssistantText(agent);
    }),
  );
}

async function main(): Promise<void> {
  console.log("Multi-Agent Subagent Example — Pi SDK + Baggage propagation\n");

  // Phase 1 — orchestrator dispatches.
  const dispatchPrompt =
    "List 2 research tasks: prime numbers and Fibonacci. One bullet each.";
  const plan = await runAgent(orchestratorAgent, ORCHESTRATOR, dispatchPrompt);

  // Phase 2 — two researchers run in parallel. Promise.all preserves
  // per-branch baggage thanks to AsyncLocalStorage.
  const [primes, fib] = await Promise.all([
    runAgent(
      primesAgent,
      RESEARCHER_PRIMES,
      "Explain primes in 2 sentences + list first 5.",
    ),
    runAgent(
      fibAgent,
      RESEARCHER_FIB,
      "Explain Fibonacci in 2 sentences + list first 8.",
    ),
  ]);

  // Phase 3 — orchestrator synthesises, reusing its Agent instance so
  // phase 1 context is already in the message history.
  const synthesis = await runAgent(
    orchestratorAgent,
    ORCHESTRATOR,
    `Synthesise in 2 sentences:\nPrimes: ${primes}\nFibonacci: ${fib}`,
  );

  console.log(`\nPlan: ${plan.slice(0, 120)}`);
  console.log(`Primes: ${primes.slice(0, 120)}`);
  console.log(`Fibonacci: ${fib.slice(0, 120)}`);
  console.log(`Synthesis: ${synthesis.slice(0, 160)}`);

  piInstrumentor.stop();
  await provider.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
