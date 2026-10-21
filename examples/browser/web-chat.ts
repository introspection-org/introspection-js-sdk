/**
 * The browser side of a web chat: connect with a session from your broker
 * route, start a task and stream its text, attach files to a later turn, and
 * resume the stream after a reload.
 *
 * Typecheck only: it needs a page, a signed-in user and the broker route in
 * `examples/patterns/web-chat.ts`, so it is not run in the examples workflow.
 *
 * The resume region sits in a block so it can show its own `render`.
 */

// #region docs:patterns/web-chat/browser-connect
import { EventType, IntrospectionApiClient, type AGUIEvent } from "@introspection-sdk/introspection-browser/api";

// Your page's code: keep the task ID across reloads and show the answer.
const saveTaskId = (id: string) => localStorage.setItem("taskId", id);
const answer = document.querySelector("#answer")!;

// A reconnect whose cursor fell out of the replay buffer yields a
// `MESSAGES_SNAPSHOT` with the run's messages so far: it replaces the
// rendered text, and later deltas append to it.
function render(event: AGUIEvent): void {
  if (event.type === EventType.MESSAGES_SNAPSHOT) {
    answer.textContent = event.messages
      .map((m) => (m.role === "assistant" && typeof m.content === "string" ? m.content : ""))
      .join("");
  } else if (event.type === EventType.TEXT_MESSAGE_CONTENT || event.type === EventType.TEXT_MESSAGE_CHUNK) {
    answer.textContent += event.delta ?? "";
  }
}

const session = () => fetch("/api/introspection/session", { method: "POST" }).then((r) => r.json());
const first = await session();
const client = new IntrospectionApiClient({
  dpUrl: first.dpUrl,
  getToken: async () => (await session()).token, // always mint fresh
});
await client.connect();

const handle = await client.tasks.start({ runtime_id: first.runtimeId, prompt: text });
saveTaskId(handle.run.task_id); // before streaming: it is also the conversation ID
for await (const event of handle.stream()) render(event);
// #endregion docs:patterns/web-chat/browser-connect

// #region docs:patterns/web-chat/attach-files
const f = await client.files.upload({ file: input.files![0] });
await client.tasks.runs.create(taskId, { kind: "prompt", prompt: { text }, files: [{ id: f.id }] });
// #endregion docs:patterns/web-chat/attach-files

{
// #region docs:patterns/web-chat/resume
  const answer = document.querySelector("#answer")!; // your page's answer element

  // A reconnect past the replay buffer yields a `MESSAGES_SNAPSHOT`: replace the text, then append deltas.
  function render(event: AGUIEvent): void {
    if (event.type === EventType.MESSAGES_SNAPSHOT) {
      answer.textContent = event.messages
        .map((m) => (m.role === "assistant" && typeof m.content === "string" ? m.content : ""))
        .join("");
    } else if (event.type === EventType.TEXT_MESSAGE_CONTENT || event.type === EventType.TEXT_MESSAGE_CHUNK) {
      answer.textContent += event.delta ?? "";
    }
  }

  const task = await client.tasks.get(taskId);
  const { active_run_id, latest_run_id } = (task.metadata ?? {}) as Record<string, string>;
  for await (const event of client.tasks.runs.stream(taskId, active_run_id ?? latest_run_id)) render(event);
// #endregion docs:patterns/web-chat/resume
}

// Stand-ins for your page.
declare const text: string;
declare const input: HTMLInputElement;
declare const taskId: string;
