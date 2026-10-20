/**
 * Share an end user's conversation from your app.
 *
 * Runs one turn, then shares the resulting conversation (the task ID) with one
 * member, or with the whole project when no member is named. The share is
 * deleted again at the end.
 *
 * Run with:
 *   INTROSPECTION_TOKEN=intro_xxx
 *   pnpm identity-sharing
 *
 * Optional env:
 *   INTROSPECTION_GRANTEE_MEMBER_ID  - member to share with (default: project)
 *   INTROSPECTION_RUNTIME            - runtime slug or ID (default customer-agent)
 *   INTROSPECTION_BASE_API_URL       - CP API host
 */

import { IntrospectionClient } from "@introspection-sdk/introspection-node";

if (!process.env.INTROSPECTION_TOKEN) {
  throw new Error("Set INTROSPECTION_TOKEN to an Introspection API key.");
}
const granted_member_id = process.env.INTROSPECTION_GRANTEE_MEMBER_ID;
const client = new IntrospectionClient();
const runner = await client
  .runtimes(process.env.INTROSPECTION_RUNTIME ?? "customer-agent")
  .run();
const handle = await runner.tasks.start({
  prompt: "Say hello in one sentence.",
});
await handle.text();
const taskId = handle.run.task_id;

// #region docs:identity/sharing/share
await client.shares.create({ resource_type: "conversation", resource_id: taskId, granted_member_id });
// #endregion docs:identity/sharing/share

const { records } = await client.shares.list();
console.log(
  `shared conversation ${taskId} with ${granted_member_id ?? "the project"}`,
);
for (const share of records) {
  if (share.resource_id === taskId) await client.shares.delete(share.id);
}
