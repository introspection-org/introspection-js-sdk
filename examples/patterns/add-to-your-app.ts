/**
 * Add an agent to your app: open a runner for the signed-in user with a
 * service account, start a task and save its ID, reconnect to its stream after
 * a reload, and record the user's feedback.
 *
 * The order store and browser push are in-memory stand-ins for your app.
 * Not run in the examples workflow: it needs service-account credentials the
 * job has no secret for.
 *
 * Run with:
 *   INTROSPECTION_SERVICE_ACCOUNT_CLIENT_ID=...
 *   INTROSPECTION_SERVICE_ACCOUNT_CLIENT_SECRET=...
 *   INTROSPECTION_PROJECT=<project id>
 *   INTROSPECTION_API_KEY=intro_xxx
 *   pnpm patterns-add-to-your-app
 *
 * Optional env:
 *   INTROSPECTION_BASE_API_URL  - CP API host
 */

type Binding = { taskId: string; userId: string };

for (const name of [
  "INTROSPECTION_SERVICE_ACCOUNT_CLIENT_ID",
  "INTROSPECTION_SERVICE_ACCOUNT_CLIENT_SECRET",
  "INTROSPECTION_PROJECT",
  "INTROSPECTION_API_KEY",
]) {
  if (!process.env[name]) throw new Error(`Set ${name}.`);
}
const bindings = new Map<string, Binding>();
const orders = {
  async saveAgentBinding(orderId: string, binding: Binding) {
    bindings.set(orderId, binding);
  },
};
async function sendEventToBrowser(event: { type: string }) {
  console.log(`[${event.type}]`);
}
const session = { user: { id: "user-4821" } };
const order = { id: "1842" };

// #region docs:patterns/add-to-your-app/open-runner
import { IntrospectionClient } from "@introspection-sdk/introspection-node";
import { IntrospectionLogs } from "@introspection-sdk/introspection-node/otel";

const credentials = {
  clientId: process.env.INTROSPECTION_SERVICE_ACCOUNT_CLIENT_ID!,
  clientSecret: process.env.INTROSPECTION_SERVICE_ACCOUNT_CLIENT_SECRET!,
  project: process.env.INTROSPECTION_PROJECT!,
};

const client = await IntrospectionClient.fromServiceAccount(credentials);
const outcomes = new IntrospectionLogs({ token: process.env.INTROSPECTION_API_KEY, serviceName: "refund-app" }); // an API key: this client keeps one token for life

const runner = await client.runtimes("refund-agent").run({
  identity: { user_id: session.user.id },
});
// #endregion docs:patterns/add-to-your-app/open-runner

// #region docs:patterns/add-to-your-app/start-task
const handle = await runner.tasks.start({
  prompt: "Review order 1842 against the refund policy and draft the next response.",
  metadata: { order_id: "1842" },
});
await orders.saveAgentBinding(order.id, { taskId: handle.run.task_id, userId: session.user.id });

for await (const event of handle.stream()) {
  await sendEventToBrowser(event);
}
// #endregion docs:patterns/add-to-your-app/start-task

// After a reload, the binding comes back from your store.
const binding = bindings.get(order.id)!;

// #region docs:patterns/add-to-your-app/reconnect
const task = await runner.tasks.get(binding.taskId);
const runId = (task.metadata?.active_run_id ?? task.metadata?.latest_run_id) as string;
for await (const event of runner.tasks.runs.stream(binding.taskId, runId)) {
  await sendEventToBrowser(event);
}
// #endregion docs:patterns/add-to-your-app/reconnect

// #region docs:patterns/add-to-your-app/feedback
const latest = await runner.tasks.get(binding.taskId);
outcomes.feedback("thumbs_down", {
  conversationId: binding.taskId,
  previousResponseId: (latest.metadata?.last_response as { response_id?: string } | undefined)?.response_id,
  comments: "Missed the final-sale rule",
});
await outcomes.flush();
// #endregion docs:patterns/add-to-your-app/feedback

await outcomes.shutdown();
