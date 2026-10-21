/**
 * Run a task for an end user: name them when you open the runner, so the
 * task, its conversation and its memory are theirs.
 *
 * Run with:
 *   INTROSPECTION_TOKEN=intro_xxx
 *   node --import tsx identity/agents.ts
 *
 * Optional env:
 *   INTROSPECTION_BASE_API_URL  - CP API host
 */

import { IntrospectionClient } from "@introspection-sdk/introspection-node";

if (!process.env.INTROSPECTION_TOKEN) {
  throw new Error("Set INTROSPECTION_TOKEN to an Introspection API key.");
}
const client = new IntrospectionClient();
// Take the user ID from your server session.
const user = { id: "user-4821" };

// #region docs:identity/agents/how-agents-act
const runner = await client.runtimes("support-agent").run({
  identity: { user_id: user.id },
});
// #endregion docs:identity/agents/how-agents-act

const handle = await runner.tasks.start({
  prompt: "Say hello in one sentence.",
});
await handle.text();
const task = await runner.tasks.get(handle.run.task_id);
console.log(`task ${task.id} is owned by member ${task.member_id}`);
