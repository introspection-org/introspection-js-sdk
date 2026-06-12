/**
 * End-to-end Runner walkthrough — Node sibling of the Rust
 * `examples/tasks_files.rs` example.
 *
 * Looks up a runtime by name, opens a Runner against it, spawns a
 * task and streams the run, then uploads a couple of files via the
 * same runner-bound `files` namespace.
 *
 * Run with:
 *   INTROSPECTION_TOKEN=intro_xxx
 *   INTROSPECTION_RUNTIME_NAME=<string, optional>
 *   pnpm api-runtimes
 *
 * Optional env:
 *   INTROSPECTION_PROJECT_ID    - overrides the project inferred from the API key
 *   INTROSPECTION_BASE_API_URL  - CP API host (default https://api.introspection.dev)
 */

import { IntrospectionClient } from "@introspection-sdk/introspection-node";

async function main() {
  const client = new IntrospectionClient();

  const runtimeName =
    process.env.INTROSPECTION_RUNTIME_NAME ?? "customer-agent";

  // 1) Open a Runner against the runtime by name. The SDK resolves
  //    the name to an id via `/v1/runtimes?name=…`, then calls
  //    `/v1/runtimes/{id}/run` which mints a short-lived access token
  //    and tells the runner which DP to talk to.
  const runner = await client.runtimes(runtimeName).run({
    identity: { user_id: "u_demo" },
  });
  console.log(
    `runner -> dp=${runner.dpEndpoint}, runtime=${runner.context?.runtime_id ?? "?"}, expires=${runner.expires_at ?? "?"}`,
  );

  // 2) Spawn a task on the runner (cursor-style sugar: one call
  //    creates the task and its first run) and stream its events.
  const run = await runner.tasks.start({
    prompt: "Say hello in one sentence.",
  });
  console.log(`spawned task=${run.task?.id}, run=${run.run.id}`);

  for await (const event of run.stream()) {
    console.log(`[${event.event}] ${event.data}`);
  }

  // 3) Bonus — upload files via the same runner.
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

  // `await` a listing for the first page (with totals); `for await` it
  // to stream every file across pages.
  const { total_count } = await runner.files.list({ include_total: true });
  console.log(`total files: ${total_count}`);

  await runner.close();
  await client.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
