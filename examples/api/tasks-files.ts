/**
 * End-to-end Runner walkthrough — Node sibling of the Rust
 * `examples/tasks_files.rs` example.
 *
 * Ensures the runtime exists (find-or-create + activate), opens a
 * Runner against it, spawns a task and streams the run, then uploads
 * a couple of files via the same runner-bound `files` namespace.
 *
 * Run with:
 *   INTROSPECTION_TOKEN=intro_xxx
 *   INTROSPECTION_PROJECT_ID=<uuid>
 *   INTROSPECTION_RECIPE_ID=<uuid>
 *   INTROSPECTION_RUNTIME_NAME=<string, optional>
 *   pnpm api-tasks-files
 *
 * Optional env:
 *   INTROSPECTION_BASE_API_URL  - CP API host (default https://api.introspection.dev)
 */

import { IntrospectionClient } from "@introspection-sdk/introspection-node";
import type { Runtime, Uuid } from "@introspection-sdk/types";

async function main() {
  const client = new IntrospectionClient();

  const projectId = requireEnv("INTROSPECTION_PROJECT_ID");
  const recipeId = requireEnv("INTROSPECTION_RECIPE_ID");
  const runtimeName =
    process.env.INTROSPECTION_RUNTIME_NAME ?? "customer-agent";

  // 1) Find-or-create the runtime by name. CP requires a project_id +
  //    a recipe pin to create; subsequent runs in this script just
  //    reuse the active row.
  const runtime = await ensureRuntime(client, projectId, recipeId, runtimeName);
  console.log(
    `runtime -> ${runtime.name} (${runtime.id}), active=${runtime.is_active}`,
  );

  // 2) Open a Runner against the runtime. CP mints a short-lived
  //    access token and tells the runner which DP to talk to.
  //    `caller` is optional segment.io-style observability data — used
  //    for telemetry / experiment-report slicing only. Routing never reads it.
  const runner = await client.runtimes(runtime.id).run({
    identity: { user_id: "u_demo" },
    caller: {
      ip: "8.8.8.8",
      user_agent: "introspection-sdk-node",
      library: {
        name: "@introspection-sdk/introspection-node",
        version: "0.2.0",
      },
    },
  });
  console.log(
    `runner -> dp=${runner.dpEndpoint}, runtime=${runner.context?.runtime_id ?? "?"}, expires=${runner.expires_at ?? "?"}`,
  );

  // 3) Spawn a task on the runner (cursor-style sugar: one call
  //    creates the task and its first run) and stream its events.
  const run = await runner.tasks.start({
    prompt: "Say hello in one sentence.",
  });
  console.log(`spawned task=${run.task?.id}, run=${run.run.id}`);

  for await (const event of run.stream()) {
    console.log(`[${event.event}] ${event.data}`);
  }

  // 4) Bonus — upload files via the same runner.
  const file = await runner.files.createText({
    name: "notes.md",
    content: "# Hello\n\nFrom the Node SDK Runner.",
    mime_type: "text/markdown",
  });
  console.log(`created file: ${file.id}`);

  const bytes = await runner.files.download(file.id);
  console.log(`downloaded ${bytes.byteLength} bytes`);

  const binary = await runner.files.upload({
    file: new TextEncoder().encode("hello binary"),
    name: "hello.bin",
    file_type: "upload",
  });
  console.log(`uploaded binary file: ${binary.id}`);

  const filesPage = await runner.files.list();
  console.log(`total files (first page): ${filesPage.records.length}`);

  await runner.close();
  await client.shutdown();
}

/**
 * Find a runtime by `name` in the project; create one pinned to
 * `recipeId` if none exists, then activate it. Returns the row the
 * rest of the example drives a runner against.
 */
async function ensureRuntime(
  client: IntrospectionClient,
  projectId: Uuid,
  recipeId: Uuid,
  name: string,
): Promise<Runtime> {
  const page = await client.runtimes.list({
    project_id: projectId,
    name,
    only_active: true,
  });
  const existing = page.records.find((r) => r.name === name);
  if (existing) {
    return existing;
  }

  console.log(`no existing runtime named '${name}'; creating one…`);
  const created = await client.runtimes.create({
    project_id: projectId,
    recipe_id: recipeId,
    name,
    description: "Created by the Node SDK tasks-files example",
  });
  // Activate so subsequent `runtimes(name).run(...)` resolutions pick it up.
  return client.runtimes(created.id).activate({ projectId });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`set ${name}`);
  }
  return value;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
