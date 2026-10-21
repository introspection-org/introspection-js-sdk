/**
 * Get structured output from an agent: read the `submit_result` tool call's
 * arguments from the run's stream, validate them against the schema, and ask
 * once more when they are missing or invalid.
 *
 * The `submit_result` tool is recipe code (an extension) and lives in the
 * recipes repo; `Triage` below is a copy of its schema.
 *
 * Run with:
 *   INTROSPECTION_TOKEN=intro_xxx
 *   pnpm patterns-structured-output
 *
 * Optional env:
 *   INTROSPECTION_RUNTIME       - runtime slug or ID (default customer-agent)
 *   INTROSPECTION_BASE_API_URL  - CP API host
 */

import {
  EventType,
  IntrospectionClient,
  type AGUIEvent,
} from "@introspection-sdk/introspection-node";
import { Type } from "typebox";

const Triage = Type.Object({
  category: Type.Union([
    Type.Literal("billing"),
    Type.Literal("bug"),
    Type.Literal("other"),
  ]),
  priority: Type.Integer({ minimum: 1, maximum: 4 }),
  summary: Type.String({ maxLength: 280 }),
});

if (!process.env.INTROSPECTION_TOKEN) {
  throw new Error("Set INTROSPECTION_TOKEN to an Introspection API key.");
}
const runtime = process.env.INTROSPECTION_RUNTIME ?? "customer-agent";
const client = new IntrospectionClient();
const runner = await client.runtimes(runtime).run();

// #region docs:patterns/structured-output/read-stream
const handle = await runner.tasks.start({ prompt: "Triage ticket 4411: ..." });
const args = new Map<string, string>();
let submitId: string | undefined;

for await (const e of handle.stream()) {
  if (e.type === EventType.MESSAGES_SNAPSHOT) submitId = fromSnapshot(e, args);
  if ((e.type === EventType.TOOL_CALL_START || e.type === EventType.TOOL_CALL_CHUNK) && e.toolCallId && e.toolCallName === "submit_result") submitId = e.toolCallId;
  if ((e.type === EventType.TOOL_CALL_ARGS || e.type === EventType.TOOL_CALL_CHUNK) && e.toolCallId) args.set(e.toolCallId, (args.get(e.toolCallId) ?? "") + (e.delta ?? ""));
}
const raw = submitId ? args.get(submitId) : undefined;
// #endregion docs:patterns/structured-output/read-stream

// A reconnect past the replay buffer yields a `MESSAGES_SNAPSHOT` with the
// run's messages so far: its tool calls replace the arguments read, and later
// deltas append to them.
function fromSnapshot(
  e: Extract<AGUIEvent, { type: EventType.MESSAGES_SNAPSHOT }>,
  args: Map<string, string>,
): string | undefined {
  let id: string | undefined;
  args.clear();
  for (const m of e.messages) {
    if (m.role !== "assistant") continue;
    for (const call of m.toolCalls ?? []) {
      args.set(call.id, call.function.arguments);
      if (call.function.name === "submit_result") id = call.id;
    }
  }
  return id;
}

const taskId = handle.run.task_id;

// #region docs:patterns/structured-output/validate
import { Value } from "typebox/value";

let result: unknown;
try {
  result = raw ? JSON.parse(raw) : undefined;
} catch {
  result = undefined; // malformed arguments count as invalid
}
if (!Value.Check(Triage, result)) {
  await runner.tasks.runs.create(taskId, {
    kind: "prompt",
    prompt: { text: "You did not call submit_result with a valid triage. Call it now." },
  });
}
// #endregion docs:patterns/structured-output/validate

console.log(`triage for task ${taskId}: ${raw ?? "(none submitted)"}`);
