/**
 * Tell the agent what a person did with its draft, outside the conversation.
 *
 * Starts a task, then steers it with a `<user_action>` message reporting that
 * the draft was sent. The draft tool itself is recipe code (an extension) and
 * lives in the recipes repo.
 *
 * Run with:
 *   INTROSPECTION_TOKEN=intro_xxx
 *   node --import tsx patterns/approve-outside.ts
 *
 * Optional env:
 *   INTROSPECTION_RUNTIME       - runtime slug or ID (default customer-agent)
 *   INTROSPECTION_BASE_API_URL  - CP API host
 */

import { IntrospectionClient } from "@introspection-sdk/introspection-node";

if (!process.env.INTROSPECTION_TOKEN) {
  throw new Error("Set INTROSPECTION_TOKEN to an Introspection API key.");
}
const client = new IntrospectionClient();
const runner = await client
  .runtimes(process.env.INTROSPECTION_RUNTIME ?? "customer-agent")
  .run();
const handle = await runner.tasks.start({
  prompt: "Draft a one-line email to maria@example.com saying hello.",
});
await handle.text();
const taskId = handle.run.task_id;

// #region docs:patterns/approve-outside/report-outcome
await runner.tasks.runs.create(taskId, {
  kind: "steer",
  prompt: { text: '<user_action kind="draft" action="sent" id="d-17" by="maria">Sent text</user_action>' },
});
// #endregion docs:patterns/approve-outside/report-outcome

console.log(`reported the sent draft to task ${taskId}`);
