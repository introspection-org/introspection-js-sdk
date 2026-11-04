/**
 * Detect that a run paused to ask the user, and resume it with the answer.
 *
 * The ask tools are recipe code (an extension) and live in the recipes repo.
 * Against a runtime without them the run finishes without an interrupt, and
 * the example says so instead of resuming.
 *
 * Run with:
 *   INTROSPECTION_TOKEN=intro_xxx
 *   node --import tsx patterns/ask-the-user.ts
 *
 * Optional env:
 *   INTROSPECTION_RUNTIME       - runtime slug or ID (default customer-agent)
 *   INTROSPECTION_BASE_API_URL  - CP API host
 */

import {
  EventType,
  IntrospectionClient,
} from "@introspection-sdk/introspection-node";
import type { Interrupt } from "@introspection-sdk/introspection-node";

if (!process.env.INTROSPECTION_TOKEN) {
  throw new Error("Set INTROSPECTION_TOKEN to an Introspection API key.");
}
const client = new IntrospectionClient();
const runner = await client
  .runtimes(process.env.INTROSPECTION_RUNTIME ?? "customer-agent")
  .run();
const handle = await runner.tasks.start({
  prompt: "Ask me which region my account is in, then say hello.",
});
const taskId = handle.run.task_id;

// #region docs:patterns/ask-the-user/detect-pause
let interrupts: Interrupt[] = [];
for await (const e of handle.stream()) {
  if (e.type === EventType.RUN_FINISHED && e.outcome?.type === "interrupt") interrupts = e.outcome.interrupts;
}
// #endregion docs:patterns/ask-the-user/detect-pause

if (interrupts.length === 0) {
  console.log("the run finished without asking; nothing to resume");
  process.exit(0);
}

// #region docs:patterns/ask-the-user/resume
await runner.tasks.runs.resume(taskId, {
  resume: [{ interruptId: interrupts[0].id, status: "resolved", payload: { answer: "EU" } }],
});
// #endregion docs:patterns/ask-the-user/resume

console.log(`resumed task ${taskId} with the answer`);
