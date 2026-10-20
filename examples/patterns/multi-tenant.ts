/**
 * Serve many customers from one runtime: name the end user and their customer
 * tag on every runner, and pass per-task configuration as metadata.
 *
 * Run with:
 *   INTROSPECTION_TOKEN=intro_xxx
 *   pnpm patterns-multi-tenant
 *
 * Optional env:
 *   INTROSPECTION_BASE_API_URL  - CP API host
 */

import { IntrospectionClient } from "@introspection-sdk/introspection-node";

if (!process.env.INTROSPECTION_TOKEN) {
  throw new Error("Set INTROSPECTION_TOKEN to an Introspection API key.");
}
const client = new IntrospectionClient();
const user = { id: "user-4821" };
const prompt = "Say hello in one sentence.";

// #region docs:patterns/multi-tenant/end-user
const runner = await client.runtimes("support-agent").run({
  identity: { user_id: user.id, tags: ["customer:acme"] },
});
// #endregion docs:patterns/multi-tenant/end-user

// #region docs:patterns/multi-tenant/per-task-config
const handle = await runner.tasks.start({
  prompt,
  metadata: { customer: "acme", playbook: "acme-v3", region: "eu" },
  tags: ["customer:acme"],
});
// #endregion docs:patterns/multi-tenant/per-task-config

console.log(await handle.text());
