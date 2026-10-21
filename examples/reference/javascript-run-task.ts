/**
 * JavaScript SDK reference: run a task.
 *
 * Backs the docs' JavaScript SDK page, "Run a task" (region
 * `reference/javascript/run-task`). The region is module-level and carries
 * its imports, as the docs do. It targets the `support-agent` runtime slug,
 * so the project needs a runtime with that slug.
 *
 * Run with:
 *   INTROSPECTION_TOKEN=intro_xxx
 *   pnpm reference-javascript-run-task
 *
 * Optional env:
 *   INTROSPECTION_BASE_API_URL  - CP API host (default https://api.introspection.dev)
 */

if (!process.env.INTROSPECTION_TOKEN) {
  console.error(
    "INTROSPECTION_TOKEN is not set: export a project API key (intro_...)",
  );
  process.exit(1);
}

// #region docs:reference/javascript/run-task
import { EventType, IntrospectionClient } from "@introspection-sdk/introspection-node";

const client = new IntrospectionClient();
const runner = await client.runtimes("support-agent").run({
  identity: { user_id: "user_123" },
});

const handle = await runner.tasks.start({ prompt: "Summarize my open tickets." });
for await (const event of handle.stream()) {
  if (event.type === EventType.TEXT_MESSAGE_CONTENT) process.stdout.write(event.delta ?? "");
}

// Follow-up turn on the same task; kind "steer" redirects a running turn.
const next = await runner.tasks.runs.create(handle.run.task_id, {
  kind: "prompt",
  prompt: { text: "Now draft the reply." },
});
console.log(await next.text());
// #endregion docs:reference/javascript/run-task

await runner.close();
await client.shutdown();
