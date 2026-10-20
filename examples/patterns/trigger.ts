/**
 * Start agent work from events: one task per incoming webhook event, and a
 * batch of tasks run in waves of five.
 *
 * The webhook handler is a Web-standard `(req: Request) => Promise<Response>`
 * route; the demo below calls it with a constructed request instead of
 * serving it.
 *
 * Run with:
 *   INTROSPECTION_TOKEN=intro_xxx
 *   pnpm patterns-trigger
 *
 * Optional env:
 *   INTROSPECTION_BASE_API_URL  - CP API host
 */

// #region docs:patterns/trigger/task-per-event
import { IntrospectionClient } from "@introspection-sdk/introspection-node";

const client = new IntrospectionClient(); // reads INTROSPECTION_TOKEN

export async function POST(req: Request) {
  const { id, text } = await req.json();
  const runner = await client.runtimes("triage-agent").run();
  const handle = await runner.tasks.start({
    prompt: `New event ${id}:\n\n${text}`,
    conversation_metadata: { event_id: id },
  });
  return Response.json({ task_id: handle.run.task_id }, { status: 202 });
}
// #endregion docs:patterns/trigger/task-per-event

if (!process.env.INTROSPECTION_TOKEN) {
  throw new Error("Set INTROSPECTION_TOKEN to an Introspection API key.");
}
const res = await POST(
  new Request("http://localhost/webhooks/events", {
    method: "POST",
    body: JSON.stringify({ id: "evt-1", text: "Checkout fails on Safari." }),
  }),
);
console.log(`webhook -> ${res.status} ${JSON.stringify(await res.json())}`);

const tickets = ["4411", "4412"];

// #region docs:patterns/trigger/batch
const runner = await client.runtimes("triage-agent").run();
for (let i = 0; i < tickets.length; i += 5) {
  const wave = await Promise.all(
    tickets.slice(i, i + 5).map((t) =>
      runner.tasks.start({ prompt: `Triage ticket ${t}`, tags: ["batch:2026-10-15"] }),
    ),
  );
  await Promise.all(wave.map((h) => h.text())); // waits for each run to settle
}
// #endregion docs:patterns/trigger/batch

console.log(`batch of ${tickets.length} settled`);
