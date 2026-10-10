/**
 * The demo page's run, on Introspection. Sam's message starts a task on the
 * travel-agent runtime (the recipe at github.com/introspection-org/recipe-travel-agent),
 * acting for Sam: the runner identity mints Sam's customer member, and the
 * platform's egress signs every call the agent makes as that member's agent.
 * The page follows each run's AG-UI stream, including the run the platform
 * starts by itself once Acme's pending decision comes back.
 *
 * Acme's emails are answered on the page, as Dana or Sam would from the email.
 */
import "server-only";

import { IntrospectionClient } from "@introspection-sdk/introspection-node";

import { clearInbox, inbox } from "../acme/mail";
import { approvalSummary, missions } from "../acme/person-server";
import { PERSON_SERVER_URL } from "../origins";
import {
  ACTOR_HEADER,
  body,
  exchanges,
  type Exchange,
  note,
  setTurn,
  startRecording,
  stopRecording,
} from "./wire";

/** Sam as the runner identity names them; Acme's Person Server knows `user:{email}`. */
const SAM_USER_ID = process.env.DEMO_SAM_USER_ID || "sam@acme.example";
const RUNTIME = process.env.INTROSPECTION_RUNTIME || "travel-agent";
/** How long to keep watching a parked task for the platform to resume it. */
const RESUME_WATCH_MS = 15 * 60 * 1000;
const RESUME_POLL_MS = 2000;

export const SCENARIOS = [
  {
    id: "approved",
    title: "Over budget, Dana approves",
    prompt:
      "Book me economy to Sydney for 19 to 23 October, and the QT Sydney. Up to $3,000.",
    hint: "Approve the trip at $3,000. The flight books on its own; approve the QT when Dana is asked.",
  },
  {
    id: "first",
    title: "First class: the rails refuse",
    prompt:
      "Fly me first class to Sydney for 19 to 23 October, with the Harbour Rocks. Up to $20,000.",
    hint: "Approve the trip. Flight Sector's Cedar rails in Introspection's egress refuse first class before Acme is asked.",
  },
  {
    id: "personal",
    title: "Personal trip on the company",
    prompt:
      "A personal weekend in Sydney, 19 to 23 October, economy and the Harbour Rocks, on the company account. Up to $3,000.",
    hint: "Approve the trip. The rails refuse each booking: personal travel is paid by the traveller.",
  },
  {
    id: "declined",
    title: "Over budget, Dana declines",
    prompt:
      "Economy to Sydney for 19 to 23 October and the QT Sydney. Up to $2,000.",
    hint: "Approve the trip at $2,000. The flight fits; decline the QT when Dana is asked.",
  },
] as const;

type Chat = { from: "Sam" | "Agent"; text: string };
type Runner = Awaited<
  ReturnType<ReturnType<IntrospectionClient["runtimes"]>["run"]>
>;
type Stream = AsyncIterable<{ type: string } & Record<string, unknown>>;
type Run = {
  prompt?: string;
  busy: boolean;
  chat: Chat[];
  error?: string;
  runner?: Runner;
  taskId?: string;
  /** Runs already followed, so a resumed run is streamed once. */
  followed: Set<string>;
  /** Bumped on every reset, so a stale follower stops writing. */
  epoch: number;
  inboxFrom: number;
  decided: number[];
  /** The chat line each email arrived under. */
  emailTurns: Record<number, number>;
  missionsFrom: number;
};

const fresh = (epoch = 0): Run => ({
  busy: false,
  chat: [],
  followed: new Set(),
  epoch,
  inboxFrom: inbox().length,
  decided: [],
  emailTurns: {},
  missionsFrom: missions().length,
});
const store = globalThis as unknown as { __demoRun?: Run };
const run = () => (store.__demoRun ??= fresh());

const say = (from: Chat["from"], text: string) => {
  const chat = run().chat;
  chat.push({ from, text });
  // What the agent does next is told in its next line, so the calls go under that one.
  setTurn(chat.length);
};

export function snapshot() {
  const r = run();
  const sent = inbox();
  const trip = missions().slice(r.missionsFrom).at(-1);
  return {
    prompt: r.prompt,
    busy: r.busy,
    chat: r.chat,
    error: r.error,
    taskId: r.taskId,
    mission: trip && {
      s256: trip.s256,
      budget_cents: trip.budget_cents,
      spent_cents: trip.spent_cents,
      terminated: trip.terminated,
    },
    exchanges: exchanges(),
    inbox: sent.slice(r.inboxFrom).map((email, i) => {
      const index = r.inboxFrom + i;
      const budget = approvalSummary(email.link.split("/").pop() ?? "")?.budget;
      r.emailTurns[index] ??= r.chat.length;
      return {
        index,
        turn: r.emailTurns[index],
        to: email.approverName,
        item: email.item,
        reasons: email.reasons,
        code: email.code,
        budget: budget
          ? {
              suggested:
                budget.suggested_cents === null
                  ? null
                  : budget.suggested_cents / 100,
            }
          : null,
        decided: r.decided.includes(index),
      };
    }),
  };
}

export function reset() {
  const old = run();
  void old.runner?.close().catch(() => undefined);
  clearInbox();
  stopRecording();
  store.__demoRun = fresh(old.epoch + 1);
}

function toolStatus(result: string) {
  try {
    const parsed = JSON.parse(result) as { status?: number; error?: unknown };
    if (typeof parsed.status === "number") return parsed.status;
    if (parsed.error) return 400;
  } catch {
    // a plain-text result
  }
  return /\b(403|forbid|denied|refused)\b/i.test(result) ? 403 : 200;
}

/** Fold one run's AG-UI events into the chat and the agent's tool calls. */
async function follow(r: Run, epoch: number, runId: string, stream: Stream) {
  r.followed.add(runId);
  const messages = new Map<string, Chat>();
  const tools = new Map<
    string,
    { exchange?: Exchange; name: string; args: string }
  >();
  for await (const ev of stream) {
    if (r.epoch !== epoch) return;
    switch (ev.type) {
      case "TEXT_MESSAGE_START": {
        say("Agent", "");
        messages.set(String(ev.messageId), r.chat.at(-1)!);
        break;
      }
      case "TEXT_MESSAGE_CONTENT": {
        const line = messages.get(String(ev.messageId));
        if (line) line.text += String(ev.delta ?? "");
        break;
      }
      case "TOOL_CALL_START": {
        tools.set(String(ev.toolCallId), {
          name: String(ev.toolCallName),
          args: "",
        });
        break;
      }
      case "TOOL_CALL_ARGS": {
        const tool = tools.get(String(ev.toolCallId));
        if (tool) tool.args += String(ev.delta ?? "");
        break;
      }
      case "TOOL_CALL_END": {
        const tool = tools.get(String(ev.toolCallId));
        if (tool)
          tool.exchange = note({
            from: "Agent",
            to: "Tools",
            label: tool.name,
            request: [`${tool.name}(…)`, ...body(tool.args)].join("\n"),
            response: "…",
            status: 102,
          });
        break;
      }
      case "TOOL_CALL_RESULT": {
        const tool = tools.get(String(ev.toolCallId));
        const content = String(ev.content ?? "");
        if (tool?.exchange) {
          tool.exchange.response = body(content).join("\n").trim() || content;
          tool.exchange.status = toolStatus(content);
        }
        break;
      }
      case "RUN_ERROR": {
        r.error = String(ev.message ?? "the run failed");
        break;
      }
    }
  }
  // Drop the empty line a message with no text leaves behind.
  r.chat = r.chat.filter((line) => line.from === "Sam" || line.text.trim());
}

/**
 * After a run settles, a parked task (waiting on Acme) is resumed by the
 * platform in a run of its own. Watch the task for that run and follow it.
 */
async function watch(r: Run, epoch: number) {
  const deadline = Date.now() + RESUME_WATCH_MS;
  while (r.epoch === epoch && Date.now() < deadline) {
    const waiting = inbox()
      .slice(r.inboxFrom)
      .some((_, i) => !r.decided.includes(r.inboxFrom + i));
    const task = await r.runner!.tasks.get(r.taskId!);
    const active = task.metadata?.active_run_id as string | undefined;
    if (active && !r.followed.has(active)) {
      await follow(
        r,
        epoch,
        active,
        r.runner!.tasks.runs.stream(r.taskId!, active) as Stream,
      );
      continue;
    }
    if (!waiting && !active) return;
    await new Promise((resolve) => setTimeout(resolve, RESUME_POLL_MS));
  }
}

async function drive(
  r: Run,
  epoch: number,
  first: () => Promise<{ runId: string; stream: Stream }>,
) {
  r.busy = true;
  r.error = undefined;
  try {
    const { runId, stream } = await first();
    await follow(r, epoch, runId, stream);
    await watch(r, epoch);
  } catch (err) {
    if (r.epoch === epoch)
      r.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (r.epoch === epoch) r.busy = false;
  }
}

/** Sam's first message: open a runner as Sam and start the task. */
export async function start(prompt: string) {
  if (run().busy) return;
  reset();
  const r = run();
  r.prompt = prompt.trim();
  startRecording();
  say("Sam", r.prompt);
  if (!process.env.INTROSPECTION_TOKEN) {
    r.error =
      "Set INTROSPECTION_TOKEN to a project API key (and INTROSPECTION_BASE_API_URL for a local control plane).";
    return;
  }
  const epoch = r.epoch;
  void drive(r, epoch, async () => {
    r.runner = await new IntrospectionClient()
      .runtimes(RUNTIME)
      .run({ identity: { user_id: SAM_USER_ID } });
    const handle = await r.runner.tasks.start({ prompt: r.prompt! });
    r.taskId = handle.run.task_id;
    return { runId: handle.run.id, stream: handle.stream() as Stream };
  });
}

/** Sam's next message, on the same task. */
export async function send(prompt: string) {
  const r = run();
  if (r.busy || !r.runner || !r.taskId || !prompt.trim()) return;
  say("Sam", prompt.trim());
  const epoch = r.epoch;
  void drive(r, epoch, async () => {
    const handle = await r.runner!.tasks.runs.create(r.taskId!, {
      prompt: { text: prompt.trim() },
    });
    return { runId: handle.run.id, stream: handle.stream() as Stream };
  });
}

/** A person answers Acme's email from the page: the same call Acme's approval page makes. */
export async function decide(
  index: number,
  verdict: "approve" | "decline",
  budgetDollars?: number,
) {
  const r = run();
  const email = inbox()[index];
  if (!email || r.decided.includes(index)) return;
  const id = email.link.split("/").pop();
  const who = email.approverName.startsWith("Sam") ? "Sam" : "Dana";
  const response = await fetch(`${PERSON_SERVER_URL}/ps/approvals/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [ACTOR_HEADER]: who },
    body: JSON.stringify({
      code: email.code,
      verdict,
      ...(budgetDollars ? { budget: budgetDollars } : {}),
    }),
  });
  if (!response.ok) {
    r.error = `Acme refused the decision: ${response.status}`;
    return;
  }
  r.decided.push(index);
}
