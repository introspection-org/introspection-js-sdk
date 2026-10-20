/**
 * Send feedback and a business event for a conversation from your backend.
 *
 * Starts a task so there is an answer to rate, then rates that answer with
 * `IntrospectionLogs.feedback` and records a `case_closed` business event with
 * `track`, both scoped to the end user.
 *
 * Run with:
 *   INTROSPECTION_TOKEN=intro_xxx
 *   pnpm observe-feedback-events
 *
 * Optional env:
 *   INTROSPECTION_RUNTIME       - runtime slug or ID (default customer-agent)
 *   INTROSPECTION_BASE_API_URL  - CP API host
 */

import { IntrospectionClient } from "@introspection-sdk/introspection-node";

if (!process.env.INTROSPECTION_TOKEN) {
  throw new Error("Set INTROSPECTION_TOKEN to an Introspection API key.");
}
const user = { id: "user-4821" };
const client = new IntrospectionClient();
const runner = await client
  .runtimes(process.env.INTROSPECTION_RUNTIME ?? "customer-agent")
  .run({ identity: { user_id: user.id } });
const started = await runner.tasks.start({
  prompt: "Say hello in one sentence.",
});
await started.text();
const task = await runner.tasks.get(started.run.task_id);

// #region docs:observe/patterns/feedback-events
import { IntrospectionLogs } from "@introspection-sdk/introspection-node/otel";

const logs = new IntrospectionLogs({ serviceName: "support-api" });

await logs.withUserId(user.id, async () => {
  logs.feedback("thumbs_down", {
    conversationId: task.id,
    previousResponseId: (task.metadata?.last_response as { response_id?: string } | undefined)?.response_id, // the answer being rated
    comments: "Applied the wrong refund rule",
  });
  logs.track("case_closed", { value: 1, plan: "pro" });
});
// #endregion docs:observe/patterns/feedback-events

await logs.flush();
await logs.shutdown();
console.log(`sent feedback and case_closed for conversation ${task.id}`);
