/**
 * JavaScript SDK reference: reattach, interrupts, files, reads, annotations
 * and task warm-up against one runner.
 *
 * Backs the docs' JavaScript SDK page past "Run a task" (regions
 * `reference/javascript/{reattach,answer-interrupt,files,`
 * `conversations-events-metrics,annotations-tags,warm-task}`). Each region is
 * the body of one function below, indented one level; `main` supplies the
 * `runner`, `client`, `taskId` and other values the snippets take as given.
 * The feedback region imports `/otel`, so it lives at module level in
 * `javascript-feedback.ts`.
 *
 * Run with:
 *   INTROSPECTION_TOKEN=intro_xxx
 *   pnpm reference-javascript
 *
 * Optional env:
 *   INTROSPECTION_RUNTIME       - runtime slug or ID (default customer-agent)
 *   INTROSPECTION_BASE_API_URL  - CP API host (default https://api.introspection.dev)
 *
 * `main` does not call `annotationsTags`: `annotations.create` needs a
 * signed-in business member's token, and an API key can only list.
 */

import {
  EventType,
  IntrospectionClient,
  type AGUIEvent,
  type Interrupt,
  type Runner,
} from "@introspection-sdk/introspection-node";

function render(event: AGUIEvent): void {
  console.log(`[${event.type}]`);
}

async function reattach(runner: Runner, taskId: string): Promise<void> {
// #region docs:reference/javascript/reattach
  const task = await runner.tasks.get(taskId);
  const metadata = task.metadata ?? {};
  const runId = String(metadata.active_run_id ?? metadata.latest_run_id);
  for await (const event of runner.tasks.runs.stream(taskId, runId)) render(event);
// #endregion docs:reference/javascript/reattach
}

async function answerInterrupt(runner: Runner, taskId: string, interruptId: string) {
// #region docs:reference/javascript/answer-interrupt
  const resumed = await runner.tasks.runs.resume(taskId, {
    resume: [{ interruptId, status: "resolved", payload: { approved: true } }],
  });
// #endregion docs:reference/javascript/answer-interrupt
  return resumed;
}

async function files(runner: Runner, buffer: Buffer) {
// #region docs:reference/javascript/files
  const spec = await runner.files.upload({ file: new Uint8Array(buffer), name: "spec.md" });
  await runner.tasks.start({ prompt: "Summarize spec.md.", files: [{ id: spec.id }] });
  const bytes = await runner.files.download(spec.id);
// #endregion docs:reference/javascript/files
  return bytes;
}

async function conversationsEventsMetrics(runner: Runner, taskId: string) {
// #region docs:reference/javascript/conversations-events-metrics
  for await (const c of runner.conversations.list({ sort: "cost", direction: "desc" })) {
    console.log(c.id, c.cost.usd);
  }
  for await (const item of runner.conversations.items.list(taskId)) console.log(item.span_id);

  for await (const e of runner.events.list({ event_name: "introspection.feedback", conversation_id: taskId })) {
    console.log(e.payload.name);
  }

  const result = await runner.metrics.query({
    view: "conversations",
    metrics: [{ measure: "total_cost_usd", aggregation: "sum" }],
    from_timestamp: "2026-07-01T00:00:00Z",
    to_timestamp: "2026-07-08T00:00:00Z",
  });
// #endregion docs:reference/javascript/conversations-events-metrics
  return result;
}

export async function annotationsTags(
  client: IntrospectionClient,
  traceId: string,
  spanId: string,
  eventId: string,
) {
// #region docs:reference/javascript/annotations-tags
  await client.tags.create({ kind: "annotation", name: "wrong-refund", color: "#f97316" });

  await client.annotations.create(
    { trace_id: traceId, span_id: spanId },
    { labels: ["wrong-refund"] },          // or { comment: "..." } or { reviewerEmails: ["dana@acme.example"] }
    { event_id: eventId },                  // optional UUIDv7; a retry with the same id never double-posts
  );

  for await (const a of client.annotations.list({ label: "wrong-refund" })) console.log(a.trace_id, a.labels);
// #endregion docs:reference/javascript/annotations-tags
}

async function warmTask(runner: Runner, userMessage: string) {
// #region docs:reference/javascript/warm-task
  const { task } = await runner.tasks.create({ title: "New conversation" });
  await runner.tasks.runs.create(task.id, { kind: "prompt", prompt: { text: userMessage } });
// #endregion docs:reference/javascript/warm-task
  return task;
}

async function main() {
  if (!process.env.INTROSPECTION_TOKEN) {
    throw new Error(
      "INTROSPECTION_TOKEN is not set: export a project API key (intro_...)",
    );
  }
  const client = new IntrospectionClient();
  const runner = await client
    .runtimes(process.env.INTROSPECTION_RUNTIME ?? "customer-agent")
    .run({ identity: { user_id: "user_123" } });

  const bytes = await files(
    runner,
    Buffer.from("# Spec\n\nReply to every ticket within one business day.\n"),
  );
  console.log(`downloaded spec.md: ${bytes.byteLength} bytes`);

  const handle = await runner.tasks.start({ prompt: "Say hello in one sentence." });
  const taskId = handle.run.task_id;
  const interrupts: Interrupt[] = [];
  for await (const event of handle.stream()) {
    if (event.type === EventType.RUN_FINISHED && event.outcome?.type === "interrupt") {
      interrupts.push(...event.outcome.interrupts);
    }
  }
  console.log(`task=${taskId} finished, ${interrupts.length} interrupt(s)`);

  await reattach(runner, taskId);
  for (const interrupt of interrupts) {
    const resumed = await answerInterrupt(runner, taskId, interrupt.id);
    console.log(await resumed.text());
  }

  const result = await conversationsEventsMetrics(runner, taskId);
  console.log(`metrics rows: ${result.data.length}`);

  const warm = await warmTask(runner, "Say hello in one sentence.");
  console.log(`warm task=${warm.id}`);

  await runner.close();
  await client.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
