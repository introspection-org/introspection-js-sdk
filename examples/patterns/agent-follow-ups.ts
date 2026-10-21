/**
 * Keep the user's time zone on the task, so a follow-up tool can schedule
 * turns in the user's local time.
 *
 * The follow-up tool itself is recipe code (an extension) and lives in the
 * recipes repo.
 *
 * Run with:
 *   INTROSPECTION_TOKEN=intro_xxx
 *   node --import tsx patterns/agent-follow-ups.ts
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
const prompt = "Say hello in one sentence.";

// #region docs:patterns/agent-follow-ups/time-zone
await runner.tasks.start({ prompt, metadata: { timezone: "Europe/London" } });
// #endregion docs:patterns/agent-follow-ups/time-zone

console.log("started a task with metadata.timezone=Europe/London");
