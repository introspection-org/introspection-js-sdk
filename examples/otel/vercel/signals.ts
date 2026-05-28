/**
 * Signal Scenarios — Vercel AI SDK
 *
 * Each scenario crafts a conversation or tool-call trace that reliably causes
 * the Introspection processor to emit a specific Plano-compatible signal.
 *
 * How signals fire:
 *   Interaction signals (disengagement / satisfaction / stagnation) are
 *   detected from user-message text in gen_ai.input.messages.
 *
 *   Execution failure signals are detected from tool-result text: the
 *   processor pairs each function_call observation with the preceding tool
 *   call and matches error patterns.
 *
 *   Execution loop signals count repeated function_call entries in the span.
 *
 *   Environment exhaustion signals are detected from tool-result text that
 *   matches infrastructure-error patterns (5xx, timeouts, 429, network, etc.).
 *
 * Signals covered:
 *   Interaction:  disengagement.{negative_stance, escalation, quit}
 *                 satisfaction.{gratitude, confirmation, success}
 *                 stagnation.dragging
 *                 misalignment.{correction, clarification}
 *   Execution:    failure.{invalid_args, tool_not_found, auth_misuse,
 *                          state_error, bad_query}
 *                 loops.{retry, parameter_drift}
 *   Environment:  exhaustion.{api_error, timeout, rate_limit, network,
 *                             malformed_response, context_overflow}
 *
 * Run with: pnpm ai-sdk-signals
 */

import { setupTracing } from "@introspection-sdk/introspection-node/otel";
import { generateText, stepCountIs, tool } from "ai";
import type { ModelMessage } from "ai";
import { anthropic } from "@ai-sdk/anthropic";
import { randomUUID } from "crypto";
import { z } from "zod";

if (!process.env.INTROSPECTION_TOKEN) {
  throw new Error("INTROSPECTION_TOKEN must be set");
}

// Haiku is sufficient for simple tool use and short conversations.
const MODEL = "claude-haiku-4-5-20251001";

// Register the global OTel provider with IntrospectionSpanProcessor — the AI
// SDK's `experimental_telemetry: { isEnabled: true }` uses it, and the
// processor's onEnd handler maps `ai.*` → `gen_ai.*` for every span the SDK
// produces. Scenarios run sequentially so no parallel span collision; each
// scenario gets a distinct conversationId via telemetry metadata.
const provider = setupTracing({ serviceName: "ai-sdk-signals" });

function telemetry(conversationId: string, functionId: string) {
  return {
    isEnabled: true,
    functionId,
    metadata: { "gen_ai.conversation.id": conversationId },
  };
}

async function run(
  messages: ModelMessage[],
  cid: string,
  fnId: string,
  opts: {
    tools?: Parameters<typeof generateText>[0]["tools"];
    maxSteps?: number;
  } = {},
): Promise<{ text: string; responseMessages: ModelMessage[] }> {
  const result = await generateText({
    model: anthropic(MODEL),
    messages,
    ...(opts.tools
      ? { tools: opts.tools, stopWhen: stepCountIs(opts.maxSteps ?? 4) }
      : {}),
    experimental_telemetry: telemetry(cid, fnId),
  });
  return {
    text: result.text,
    responseMessages: result.response.messages as ModelMessage[],
  };
}

// ── Interaction: disengagement ────────────────────────────────────────────────

async function negativeStance() {
  const cid = randomUUID();
  const msgs: ModelMessage[] = [
    { role: "user", content: "How do I reset my password?" },
  ];
  const { responseMessages } = await run(
    msgs,
    cid,
    "disengagement-negative-stance",
  );
  // User expresses frustration → disengagement.negative_stance
  await run(
    [
      ...msgs,
      ...responseMessages,
      {
        role: "user",
        content: "This is useless, you're not helping me at all.",
      },
    ],
    cid,
    "disengagement-negative-stance",
  );
}

async function escalation() {
  const cid = randomUUID();
  const msgs: ModelMessage[] = [
    { role: "user", content: "I have a billing dispute on my account." },
  ];
  const { responseMessages } = await run(msgs, cid, "disengagement-escalation");
  // User requests a human → disengagement.escalation
  await run(
    [
      ...msgs,
      ...responseMessages,
      {
        role: "user",
        content: "This is still unresolved. Get me a human agent please.",
      },
    ],
    cid,
    "disengagement-escalation",
  );
}

async function quit() {
  const cid = randomUUID();
  const msgs: ModelMessage[] = [
    { role: "user", content: "Help me configure my account settings." },
  ];
  const { responseMessages } = await run(msgs, cid, "disengagement-quit");
  // User gives up → disengagement.quit
  await run(
    [
      ...msgs,
      ...responseMessages,
      {
        role: "user",
        content: "Forget it, I give up. This is going nowhere.",
      },
    ],
    cid,
    "disengagement-quit",
  );
}

// ── Interaction: satisfaction ─────────────────────────────────────────────────

async function gratitude() {
  const cid = randomUUID();
  const msgs: ModelMessage[] = [
    { role: "user", content: "How do I sort a list in Python?" },
  ];
  const { responseMessages } = await run(msgs, cid, "satisfaction-gratitude");
  // User thanks the agent → satisfaction.gratitude
  await run(
    [
      ...msgs,
      ...responseMessages,
      {
        role: "user",
        content: "That's perfect, appreciate it! Really helpful.",
      },
    ],
    cid,
    "satisfaction-gratitude",
  );
}

async function confirmation() {
  const cid = randomUUID();
  const msgs: ModelMessage[] = [
    { role: "user", content: "Explain async/await in JavaScript briefly." },
  ];
  const { responseMessages } = await run(
    msgs,
    cid,
    "satisfaction-confirmation",
  );
  // User confirms it works → satisfaction.confirmation
  await run(
    [
      ...msgs,
      ...responseMessages,
      {
        role: "user",
        content: "That works perfectly, love it! Solves my issue.",
      },
    ],
    cid,
    "satisfaction-confirmation",
  );
}

async function success() {
  const cid = randomUUID();
  const msgs: ModelMessage[] = [
    { role: "user", content: "How do I fix a 404 error in Express.js?" },
  ];
  const { responseMessages } = await run(msgs, cid, "satisfaction-success");
  // User reports task done → satisfaction.success
  await run(
    [
      ...msgs,
      ...responseMessages,
      { role: "user", content: "It worked! That fix did the job, thanks." },
    ],
    cid,
    "satisfaction-success",
  );
}

// ── Interaction: misalignment ─────────────────────────────────────────────────
//
// Misalignment fires when the user corrects the assistant or re-asks the same
// question because the answer missed the intent. These map to the legacy
// signals.follow_up.repair.* aggregates.

async function correction() {
  // User explicitly corrects the assistant → misalignment.correction
  const cid = randomUUID();
  const msgs: ModelMessage[] = [
    { role: "user", content: "Book a flight from Boston to Portland." },
  ];
  const { responseMessages } = await run(msgs, cid, "misalignment-correction");
  await run(
    [
      ...msgs,
      ...responseMessages,
      {
        role: "user",
        content:
          "No, I meant Portland, Maine — not Portland, Oregon. Please redo it.",
      },
    ],
    cid,
    "misalignment-correction",
  );
}

async function clarification() {
  // User asks for clarification because the previous answer was unclear →
  // misalignment.clarification (brightstaff phrase list includes "don't
  // understand", "what do you mean", "can you clarify").
  const cid = randomUUID();
  const msgs: ModelMessage[] = [
    {
      role: "user",
      content: "How do I cancel my subscription? I need the exact steps.",
    },
  ];
  const { responseMessages } = await run(
    msgs,
    cid,
    "misalignment-clarification",
  );
  await run(
    [
      ...msgs,
      ...responseMessages,
      {
        role: "user",
        content:
          "I don't understand what you mean by that. Can you clarify the exact steps?",
      },
    ],
    cid,
    "misalignment-clarification",
  );
}

// ── Interaction: stagnation ───────────────────────────────────────────────────

async function dragging() {
  // stagnation.dragging fires when efficiency_score < 0.5.
  // efficiency_score = 1 / (1 + excess * 0.25) where excess = user_turns - 5.
  // Need ≥ 10 user turns: efficiency = 1/(1 + 5*0.25) = 0.44 < 0.5.
  //
  // Each generateText call receives accumulated history, so by the 10th call
  // gen_ai.input.messages contains all 10 user messages → dragging fires.
  const cid = randomUUID();
  const questions = [
    "What is a variable in programming?",
    "What is a function?",
    "What is a loop?",
    "What is recursion?",
    "What is an array?",
    "What is an object in OOP?",
    "What is a class?",
    "What is inheritance?",
    "What is polymorphism?",
    "What is encapsulation?",
  ];
  const history: ModelMessage[] = [];
  for (const q of questions) {
    const messages: ModelMessage[] = [...history, { role: "user", content: q }];
    const { responseMessages } = await run(
      messages,
      cid,
      "stagnation-dragging",
    );
    history.push({ role: "user", content: q }, ...responseMessages);
  }
}

// ── Execution: failures ───────────────────────────────────────────────────────

async function invalidArgs() {
  // Tool result matches invalid_args pattern: "validation failed"
  const cid = randomUUID();
  const createUser = tool({
    description: "Create a new user account with name and age.",
    inputSchema: z.object({
      name: z.string(),
      age: z.string().describe("The user's age"),
    }),
    execute: async () =>
      "Error: validation failed — expected integer got string for field 'age'",
  });
  await run(
    [{ role: "user", content: "Create a user named Alice, age 30." }],
    cid,
    "failure-invalid-args",
    { tools: { createUser }, maxSteps: 3 },
  );
}

async function toolNotFound() {
  // Tool result matches tool_not_found pattern: "unknown function"
  const cid = randomUUID();
  const sendReport = tool({
    description: "Send a report to the team.",
    inputSchema: z.object({ title: z.string() }),
    execute: async ({ title }) =>
      `Error: unknown function 'sendReport' — no such tool is registered (called with title="${title}")`,
  });
  await run(
    [
      {
        role: "user",
        content: "Send a weekly summary report to the engineering team.",
      },
    ],
    cid,
    "failure-tool-not-found",
    { tools: { sendReport }, maxSteps: 3 },
  );
}

async function authMisuse() {
  // Tool result matches auth_misuse pattern: "401 Unauthorized"
  const cid = randomUUID();
  const getSecretData = tool({
    description: "Retrieve a secret value from the secrets vault.",
    inputSchema: z.object({ key: z.string() }),
    execute: async () =>
      "HTTP 401 Unauthorized — invalid credentials, please check your API token",
  });
  await run(
    [{ role: "user", content: "Get the API secret key from the vault." }],
    cid,
    "failure-auth-misuse",
    { tools: { getSecretData }, maxSteps: 3 },
  );
}

async function stateError() {
  // Tool result matches state_error pattern: "must call ... first"
  const cid = randomUUID();
  const commitTransaction = tool({
    description: "Commit a pending database transaction.",
    inputSchema: z.object({ transactionId: z.string() }),
    execute: async () =>
      "Error: invalid state — must call begin_session first before committing a transaction",
  });
  await run(
    [{ role: "user", content: "Commit the pending transaction tx-abc123." }],
    cid,
    "failure-state-error",
    { tools: { commitTransaction }, maxSteps: 3 },
  );
}

async function badQuery() {
  // Tool result matches bad_query pattern: "invalid query syntax error"
  const cid = randomUUID();
  const searchDatabase = tool({
    description: "Search the product database with a query string.",
    inputSchema: z.object({ query: z.string() }),
    execute: async ({ query }) =>
      `Error: invalid query syntax error near '${query}' — unknown field in filter expression`,
  });
  await run(
    [
      {
        role: "user",
        content:
          "Search the database for active electronics products with price < 100.",
      },
    ],
    cid,
    "failure-bad-query",
    { tools: { searchDatabase }, maxSteps: 3 },
  );
}

// ── Execution: loops ──────────────────────────────────────────────────────────

async function retryLoop() {
  // execution.loops.retry: same tool + same args called ≥ 3 times in a row.
  // The timeout error prompts the model to retry with the same host each time.
  // Note: each observation also fires environment.exhaustion.timeout — both
  // signals coexist, which is realistic for a timed-out retry loop.
  const cid = randomUUID();
  const pingServer = tool({
    description: "Ping a server host to check if it is reachable.",
    inputSchema: z.object({ host: z.string() }),
    execute: async () =>
      "Connection timed out after 30 seconds — the host did not respond",
  });
  await run(
    [
      {
        role: "user",
        content:
          "Ping api.example.com. If it times out, retry with the exact same host — try at least 4 times in total before giving up.",
      },
    ],
    cid,
    "loops-retry",
    { tools: { pingServer }, maxSteps: 6 },
  );
}

async function parameterDrift() {
  // execution.loops.parameter_drift: same tool called ≥ 3 times with different
  // argument values. The search always returns no results, so the model tries
  // progressively different query strings.
  const cid = randomUUID();
  const searchDocs = tool({
    description: "Search the documentation for a given query string.",
    inputSchema: z.object({ query: z.string() }),
    execute: async () => "No results found for your query.",
  });
  await run(
    [
      {
        role: "user",
        content:
          "Find documentation about authentication. If you get no results, try at least 3 more different search terms (e.g. 'auth', 'login', 'OAuth', 'API keys').",
      },
    ],
    cid,
    "loops-parameter-drift",
    { tools: { searchDocs }, maxSteps: 8 },
  );
}

// ── Environment: exhaustion ───────────────────────────────────────────────────

function exhaustionScenario(
  fnId: string,
  userPrompt: string,
  toolError: string,
): () => Promise<void> {
  return async () => {
    const cid = randomUUID();
    const callApi = tool({
      description: "Call an external service API endpoint.",
      inputSchema: z.object({ endpoint: z.string() }),
      execute: async () => toolError,
    });
    await run([{ role: "user", content: userPrompt }], cid, fnId, {
      tools: { callApi },
      maxSteps: 3,
    });
  };
}

const apiError = exhaustionScenario(
  "environment-api-error",
  "Fetch the latest report from the reporting service API.",
  "503 service unavailable — the server is temporarily down, try again later",
);

const timeout = exhaustionScenario(
  "environment-timeout",
  "Retrieve analytics data from the analytics API.",
  "Connection timed out after 30 seconds — request exceeded the maximum wait time",
);

const rateLimit = exhaustionScenario(
  "environment-rate-limit",
  "Fetch the data ingestion status from the pipeline API.",
  "HTTP 429: too many requests — quota exceeded, retry after 60 seconds",
);

const networkError = exhaustionScenario(
  "environment-network",
  "Call the notifications service to get pending alerts.",
  "ECONNREFUSED: connection refused by remote host at 10.0.0.1:443 — unable to connect",
);

const malformedResponse = exhaustionScenario(
  "environment-malformed",
  "Fetch the inventory count from the warehouse API.",
  "Invalid JSON: unexpected token '<' at position 0 — response body was malformed HTML",
);

const contextOverflow = exhaustionScenario(
  "environment-context-overflow",
  "Summarize the full document archive from the storage API.",
  "Error: Maximum context length exceeded — the input is too long for this model to process",
);

// ── Main ──────────────────────────────────────────────────────────────────────

const SCENARIOS: [string, () => Promise<void>][] = [
  // Interaction layer
  ["disengagement.negative_stance", negativeStance],
  ["disengagement.escalation", escalation],
  ["disengagement.quit", quit],
  ["satisfaction.gratitude", gratitude],
  ["satisfaction.confirmation", confirmation],
  ["satisfaction.success", success],
  ["misalignment.correction", correction],
  ["misalignment.clarification", clarification],
  ["stagnation.dragging", dragging],
  // Execution layer — failures
  ["execution.failure.invalid_args", invalidArgs],
  ["execution.failure.tool_not_found", toolNotFound],
  ["execution.failure.auth_misuse", authMisuse],
  ["execution.failure.state_error", stateError],
  ["execution.failure.bad_query", badQuery],
  // Execution layer — loops
  ["execution.loops.retry", retryLoop],
  ["execution.loops.parameter_drift", parameterDrift],
  // Environment layer
  ["environment.exhaustion.api_error", apiError],
  ["environment.exhaustion.timeout", timeout],
  ["environment.exhaustion.rate_limit", rateLimit],
  ["environment.exhaustion.network", networkError],
  ["environment.exhaustion.malformed_response", malformedResponse],
  ["environment.exhaustion.context_overflow", contextOverflow],
];

async function main() {
  console.log("Signal Scenarios — Vercel AI SDK");
  console.log(`Running ${SCENARIOS.length} scenarios...\n`);

  for (const [name, fn] of SCENARIOS) {
    process.stdout.write(`→ ${name} ... `);
    try {
      await fn();
      console.log("done");
    } catch (err) {
      console.log(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await provider.shutdown();
  console.log("\nDone — check Introspection for signals on each conversation.");
}

main().catch(console.error);
