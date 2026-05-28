/**
 * Multi-Agent Subagent Example — LangChain (Callback handler + baggage)
 *
 * Same scenario as anthropic-sdk/subagents-baggage.ts, built on LangChain
 * using the same baggage pattern:
 *
 *   await introspect.withAgent(agentName, agentId, () =>
 *     introspect.withConversation(conversationId, undefined, () =>
 *       model.invoke(messages, { callbacks: [handler] }),
 *     ),
 *   );
 *
 *   - One shared `IntrospectionCallbackHandler` for the whole process.
 *   - One shared `ChatAnthropic` model instance.
 *   - Per-call identity flows via OTel baggage. The handler reads
 *     `gen_ai.conversation.id`, `gen_ai.agent.name`, and `gen_ai.agent.id`
 *     from the active baggage automatically — no `RunnableLambda` /
 *     `withConfig({ runName })` wiring required.
 *   - `Promise.all` is safe because `AsyncLocalStorageContextManager`
 *     (installed by `setupTracing`) forks the baggage context per branch.
 *
 * Run with: pnpm langchain-subagents
 */

import { IntrospectionClient } from "@introspection-sdk/introspection-node";
import { setupTracing } from "@introspection-sdk/introspection-node/otel";
import { IntrospectionCallbackHandler } from "@introspection-sdk/introspection-node/langchain";
import { ChatAnthropic } from "@langchain/anthropic";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";
import { randomUUID } from "crypto";

// ── One-call setup ─────────────────────────────────────────────────────────
// setupTracing registers the AsyncLocalStorageContextManager + W3C baggage
// propagator that withGenAi() relies on. Without it, baggage is silently
// dropped and identity won't reach the handler.
setupTracing({ serviceName: "langchain-subagents" });

const introspect = new IntrospectionClient();
const handler = new IntrospectionCallbackHandler({
  serviceName: "langchain-subagents",
});

// ── Shared model ───────────────────────────────────────────────────────────
const model = new ChatAnthropic({
  model: "claude-sonnet-4-6",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  betas: ["extended-cache-ttl-2025-04-11" as any],
});

// A ≥1024-token system prompt is required for Anthropic's prompt cache to
// engage. 100 repetitions ≈ 1109 tokens — safely above the 1024-token minimum.
const SYSTEM_PROMPT =
  "You are a concise research assistant. " +
  "Answer the user's question in at most two sentences. ".repeat(100);

const systemMessage = new SystemMessage({
  content: [
    {
      type: "text",
      text: SYSTEM_PROMPT,
      // @ts-ignore — cache_control is valid per Anthropic API but not yet typed in @langchain/core
      cache_control: { type: "ephemeral" },
    },
  ],
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

interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

function buildMessages(prompt: string, history: HistoryTurn[]): BaseMessage[] {
  const past: BaseMessage[] = history.map((turn) =>
    turn.role === "user"
      ? new HumanMessage(turn.content)
      : new AIMessage(turn.content),
  );
  return [systemMessage, ...past, new HumanMessage(prompt)];
}

function extractText(response: AIMessage): string {
  const content = response.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        typeof block === "string"
          ? block
          : typeof block === "object" &&
              "type" in block &&
              block.type === "text"
            ? (block as { type: "text"; text: string }).text
            : "",
      )
      .join("");
  }
  return String(content);
}

async function runAgent(
  id: AgentIdentity,
  prompt: string,
  history: HistoryTurn[] = [],
): Promise<string> {
  return introspect.withAgent(id.agentName, id.agentId, () =>
    introspect.withConversation(id.conversationId, undefined, async () => {
      const response = (await model.invoke(buildMessages(prompt, history), {
        callbacks: [handler],
      })) as AIMessage;
      return extractText(response);
    }),
  );
}

async function main(): Promise<void> {
  console.log("Multi-Agent Subagent Example — LangChain (baggage)\n");

  // Phase 1 — orchestrator dispatches.
  const dispatchPrompt =
    "List 2 research tasks: prime numbers and Fibonacci. One bullet each.";
  const plan = await runAgent(ORCHESTRATOR, dispatchPrompt);

  // Phase 2 — two researchers in parallel. Each branch sees its own baggage
  // thanks to AsyncLocalStorageContextManager.
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

  // Phase 3 — orchestrator synthesises, sharing Phase 1's conversationId so
  // both turns link together in Introspection.
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

  await handler.shutdown();
  console.log("Done — spans exported to Introspection.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
