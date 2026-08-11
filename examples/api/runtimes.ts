/**
 * End-to-end Runner walkthrough.
 *
 * Looks up a runtime by runtime group slug or ID, opens a Runner against it, spawns a
 * task and streams the run, then uploads a couple of files via the
 * same runner-bound `files` namespace.
 *
 * Run with:
 *   INTROSPECTION_TOKEN=intro_xxx
 *   INTROSPECTION_RUNTIME=<runtime group slug or ID, optional>
 *   pnpm api-runtimes
 *
 * Optional env:
 *   INTROSPECTION_BASE_API_URL  - CP API host (default https://api.introspection.dev)
 *
 * The project is scoped by the API key — there is no client-level project
 * option or env override.
 */

import {
  IntrospectionClient,
  genAiOutputMessages,
} from "@introspection-sdk/introspection-node";

async function main() {
  const client = new IntrospectionClient();

  const runtime = process.env.INTROSPECTION_RUNTIME ?? "customer-agent";

  // 1) Open a Runner against the runtime group slug or ID. The SDK resolves
  //    it via `/v1/runtimes?runtime=…`, then calls
  //    `/v1/runtimes/{id}/run` which mints a short-lived access token
  //    and tells the runner which DP to talk to.
  const runner = await client.runtimes(runtime).run({
    identity: { user_id: "u_demo" },
  });
  console.log(
    `runner -> dp=${runner.dpEndpoint}, runtime=${runner.context?.runtime_id ?? "?"}, expires=${runner.expires_at ?? "?"}`,
  );

  // 2) Spawn a task on the runner (cursor-style sugar: one call
  //    creates the task and its first run) and stream its events.
  // Tags stamped here group the task for `tasks.list({ tag })`, and are
  // access-bearing: a caller whose member tags intersect them can read and
  // write this task. Member tags are set by an org owner through the members
  // API — a runner identity cannot assert its own.
  const run = await runner.tasks.start({
    tags: ["project:x"],
    prompt: "Say hello in one sentence.",
  });
  console.log(`spawned task=${run.task?.id}, run=${run.run.id}`);

  for await (const event of run.stream()) {
    console.log(`[${event.type}]`);
  }

  // 3) Once the run has drained, the task carries its conversation id in
  //    metadata. Fetch that conversation, then mint a read-share for it —
  //    the grant's `url` (carrying the `?share_id` capability) is what you
  //    hand to someone else, or feed back as `fork_share_id` to branch a
  //    new task off this conversation.
  const conversationId = run.task?.metadata?.conversation_id as
    string | undefined;
  if (conversationId) {
    // The read returns the turn as a GenAI span: semconv attribute names,
    // full input history, nothing renamed on the way out.
    const span = await runner.conversations.retrieve(conversationId);
    if (span) {
      const genAi = span.attributes.gen_ai;
      const model = genAi?.response?.model ?? genAi?.request?.model ?? "?";
      console.log(
        `completed conversation ${conversationId}: model=${model}, ` +
          `${genAiOutputMessages(span).length} output message(s)`,
      );
    }
    const share = await runner.shares.create({
      resource_type: "conversation",
      resource_id: conversationId,
    });
    console.log(`shared conversation -> ${share.url}`);
    // Branch a fresh task off the shared conversation's history:
    //   await runner.tasks.create({ prompt: "continue", fork_share_id: share.id });
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
