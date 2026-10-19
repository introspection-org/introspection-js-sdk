/**
 * The demo page's run, on Introspection. Sam's message starts a task on the
 * travel-agent runtime (the recipe at github.com/introspection-recipes/recipe-travel-agent),
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
import { approvalSummary, missions } from "../acme/approvals";
import { fetchRetrying } from "../retry";
import {
  ACME_APPROVAL_URL,
  BOOKING_ISSUER,
  BROWSERBASE_MCP_URL,
} from "../origins";
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
const RESUME_POLL_MS = 1000;
/** How long after a decision the platform may take to resume the task. */
const RESUME_SETTLE_MS = 60 * 1000;

/** `mcp_browserbase_start_7683c2b5…` reads as `browserbase: start`. */
function toolLabel(name: string) {
  const mcp = /^mcp_([a-z0-9-]+)_(.+?)(?:_[0-9a-f]{6,})?$/.exec(name);
  return mcp ? `${mcp[1]}: ${mcp[2]}` : name;
}

export const SCENARIOS = [
  {
    id: "approved",
    title: "Over budget, Dana declines, Sam's easy",
    prompt:
      "Book me economy from San Francisco to Sydney for 19 to 23 October, and the QT Sydney. Up to $3,000.",
    hint: "Approve the trip at $3,000. The flight books on its own; decline the QT when Dana is asked, then tell the agent you're easy and it finds a cheaper hotel.",
  },
  {
    id: "first",
    title: "First class: refused by the rails",
    prompt:
      "Fly me first class from San Francisco to Sydney for 19 to 23 October, with the Harbour Rocks. Up to $20,000.",
    hint: "The agent quotes first class, and Flight Sector's Cedar rails in Introspection's egress refuse it at the quote, before Acme is asked.",
  },
  {
    id: "personal",
    title: "A personal weekend on the company: refused",
    prompt:
      "Book me economy from San Francisco to Sydney for 19 to 23 October for the Acme offsite, then on to Melbourne for a weekend with my partner, 23 to 25 October. Put it all on Acme. Up to $4,000.",
    hint: "Approve the trip. Sydney books on the company; the rails refuse the Melbourne weekend on the company, with Jev reading it as personal, so the agent offers to put it on Sam's card.",
  },
] as const;

type Chat = { from: "Sam" | "Agent"; text: string };
/** A tool call that failed, under the chat line that follows it, as the wire's calls are. */
type ToolError = { turn: number; tool: string; text: string };
type Runner = Awaited<
  ReturnType<ReturnType<IntrospectionClient["runtimes"]>["run"]>
>;
type Stream = AsyncIterable<{ type: string } & Record<string, unknown>>;
type Run = {
  prompt?: string;
  busy: boolean;
  chat: Chat[];
  toolErrors: ToolError[];
  error?: string;
  runner?: Runner;
  taskId?: string;
  /** Runs already followed, so a resumed run is streamed once. */
  followed: Set<string>;
  /** Bumped on every reset, so a stale follower stops writing. */
  epoch: number;
  inboxFrom: number;
  decided: number[];
  /** When someone last answered Acme, so watching outlasts the platform's resume. */
  decidedAt?: number;
  /** A run's stream is open: the agent is replying, not just being watched for. */
  streaming?: boolean;
  /** The chat line each email arrived under. */
  emailTurns: Record<number, number>;
  missionsFrom: number;
};

const fresh = (epoch = 0): Run => ({
  busy: false,
  chat: [],
  toolErrors: [],
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

/** Where the Introspection app shows this project's conversations. */
function conversationsUrl() {
  const project = process.env.INTROSPECTION_PROJECT_URL?.replace(/\/+$/, "");
  return project ? `${project}/conversations/` : undefined;
}

export function snapshot() {
  const r = run();
  const sent = inbox();
  const trip = missions().slice(r.missionsFrom).at(-1);
  return {
    prompt: r.prompt,
    busy: r.busy,
    chat: r.chat,
    toolErrors: r.toolErrors,
    error: r.error,
    taskId: r.taskId,
    working: r.busy && !!r.streaming,
    conversations: conversationsUrl(),
    hosts: {
      Acme: new URL(ACME_APPROVAL_URL).host,
      "Booking provider": new URL(BOOKING_ISSUER).host,
      Browserbase: process.env.BROWSERBASE_API_KEY
        ? "mcp.browserbase.com"
        : `${new URL(BROWSERBASE_MCP_URL).host} (mock)`,
    } as Record<string, string>,
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

/**
 * Why a tool call failed, in a line: `HTTP 503 no healthy upstream`, or
 * undefined when it did not. The result is the tool's own object, whose
 * `isError` the recipe sets; an approval steer (428) is not a failure.
 */
function toolError(content: string) {
  let text = content;
  let failed = false;
  try {
    const parsed = JSON.parse(content) as {
      isError?: unknown;
      content?: unknown;
    };
    if (parsed && typeof parsed === "object") {
      failed = parsed.isError === true;
      const part = Array.isArray(parsed.content)
        ? (parsed.content as { type?: string; text?: unknown }[]).find(
            (c) => c?.type === "text",
          )
        : undefined;
      if (typeof part?.text === "string") text = part.text;
    }
  } catch {
    // a plain-text result
  }
  text = text.trim();
  const http = /^HTTP (\d{3})\b\s*([\s\S]*)$/.exec(text);
  if (http) {
    const status = Number(http[1]);
    failed ||= status >= 400 && status !== 428;
    if (!failed) return undefined;
    let reason = http[2].trim();
    try {
      const problem = JSON.parse(reason) as {
        detail?: unknown;
        title?: unknown;
        error?: unknown;
      };
      const said = [problem.detail, problem.title, problem.error].find(
        (v) => typeof v === "string" && v,
      );
      if (typeof said === "string") reason = said;
    } catch {
      // not a problem document
    }
    text = `HTTP ${status} ${reason}`;
  }
  if (!failed) return undefined;
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" ");
  return lines.length > 200 ? `${lines.slice(0, 199)}…` : lines;
}

/** Fold one run's AG-UI events into the chat and the agent's tool calls. */
async function follow(r: Run, epoch: number, runId: string, stream: Stream) {
  r.followed.add(runId);
  r.streaming = true;
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
            label: toolLabel(tool.name),
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
        const failed = toolError(content);
        if (tool && failed)
          r.toolErrors.push({
            turn: r.chat.length,
            tool: toolLabel(tool.name),
            text: failed,
          });
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
    // A run the platform resumes can finish between polls, so the latest counts too.
    const active = task.metadata?.active_run_id as string | undefined;
    const latest = task.metadata?.latest_run_id as string | undefined;
    const next = [active, latest].find((id) => id && !r.followed.has(id));
    if (next) {
      await follow(
        r,
        epoch,
        next,
        r.runner!.tasks.runs.stream(r.taskId!, next) as Stream,
      );
      r.streaming = false;
      continue;
    }
    const settling = Date.now() - (r.decidedAt ?? 0) < RESUME_SETTLE_MS;
    if (!waiting && !active && !settling) return;
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
    r.streaming = false;
    await watch(r, epoch);
  } catch (err) {
    if (r.epoch === epoch)
      r.error = err instanceof Error ? err.message : String(err);
  } finally {
    if (r.epoch === epoch) r.busy = false;
  }
}

/**
 * The demo page signs in as the agent's application. Its token lasts about an
 * hour, so each conversation started or loaded mints its own.
 */
function serviceAccount() {
  const clientId = process.env.INTROSPECTION_CLIENT_ID;
  const clientSecret = process.env.INTROSPECTION_CLIENT_SECRET;
  const project = process.env.INTROSPECTION_PROJECT;
  if (!clientId || !clientSecret || !project) return null;
  return {
    clientId,
    clientSecret,
    project,
    baseApiUrl: process.env.INTROSPECTION_BASE_API_URL,
  };
}

function notSetUp() {
  return process.env.DEMO_SETUP === "pending"
    ? "pnpm dev is still setting up your project: send this again once it prints the demo URL."
    : "Run pnpm dev to set up the agent's application: INTROSPECTION_CLIENT_ID, INTROSPECTION_CLIENT_SECRET and INTROSPECTION_PROJECT.";
}

/** Sam's first message: open a runner as Sam and start the task. */
export async function start(prompt: string) {
  if (run().busy) return;
  reset();
  const r = run();
  r.prompt = prompt.trim();
  startRecording();
  say("Sam", r.prompt);
  const account = serviceAccount();
  if (!account) {
    r.error = notSetUp();
    return;
  }
  const epoch = r.epoch;
  void drive(r, epoch, async () => {
    r.runner = await (
      await IntrospectionClient.fromServiceAccount(account)
    )
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
  if (r.streaming || !r.runner || !r.taskId || !prompt.trim()) return;
  // Only watching for a resume, not replying: Sam may speak, which ends the watch.
  if (r.busy) r.epoch += 1;
  say("Sam", prompt.trim());
  const epoch = r.epoch;
  void drive(r, epoch, async () => {
    const handle = await r.runner!.tasks.runs.create(r.taskId!, {
      prompt: { text: prompt.trim() },
    });
    return { runId: handle.run.id, stream: handle.stream() as Stream };
  });
}

/** Sam stops the agent: cancel whichever run the task is on. The task stays, so Sam can carry on. */
export async function stop() {
  const r = run();
  if (!r.runner || !r.taskId || !r.busy) return;
  try {
    await r.runner.tasks.runs.cancel(r.taskId, "current");
  } catch (err) {
    r.error = `Could not stop the agent: ${err instanceof Error ? err.message : String(err)}`;
    return;
  }
  r.epoch += 1;
  r.busy = false;
  r.streaming = false;
}

/** The conversation so far, from its turns in Introspection, oldest first, with when each line was said. */
async function history(runner: Runner, taskId: string) {
  const turns = [];
  for await (const turn of runner.conversations.turns(taskId, { limit: 100 }))
    turns.push(turn);
  return (
    turns
      .sort((a, b) => a.started_at.localeCompare(b.started_at))
      .flatMap((turn) =>
        turn.messages.map((message) => ({
          from: message.role === "user" ? ("Sam" as const) : ("Agent" as const),
          text: message.parts
            .map((part) =>
              part.type === "text" && "content" in part ? part.content : "",
            )
            .join(""),
          at: message.created_at,
        })),
      )
      // The platform resumes the agent with a `[platform]` message of its own,
      // which the live chat never shows.
      .filter(
        (line) =>
          line.text.trim() &&
          !(line.from === "Sam" && line.text.startsWith("[platform]")),
      )
  );
}

type Part = {
  type: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  response?: unknown;
};
type Message = { parts?: Part[] };

/**
 * The agent's tool calls, each under the chat line it followed, from the
 * conversation's items: the model's calls and the results it was given back.
 * What happened on the wire behind them is not recorded, so it is not restored.
 * The ones that failed go into `errors`, for the chat's "why".
 */
async function toolCalls(
  runner: Runner,
  taskId: string,
  lines: { at: string }[],
  errors: ToolError[],
) {
  const calls: { id: string; name: string; args: string; at: string }[] = [];
  const results = new Map<string, unknown>();
  for await (const span of runner.conversations.items.list(taskId, {
    limit: 500,
  })) {
    const genAi = span.attributes?.gen_ai as
      | { input?: { messages?: Message[] }; output?: { messages?: Message[] } }
      | undefined;
    for (const message of genAi?.input?.messages ?? [])
      for (const part of message.parts ?? [])
        if (part.type === "tool_call_response" && part.id)
          results.set(part.id, part.response);
    for (const message of genAi?.output?.messages ?? [])
      for (const part of message.parts ?? [])
        if (part.type === "tool_call" && part.id && part.name)
          calls.push({
            id: part.id,
            name: part.name,
            args:
              typeof part.arguments === "string"
                ? part.arguments
                : JSON.stringify(part.arguments ?? {}),
            at: span.end_time ?? span.start_time,
          });
  }
  for (const call of calls.sort((a, b) => a.at.localeCompare(b.at))) {
    const turn = lines.filter((line) => line.at <= call.at).length;
    setTurn(turn);
    const result = results.get(call.id);
    const content =
      typeof result === "string" ? result : JSON.stringify(result ?? "");
    const failed = result === undefined ? undefined : toolError(content);
    if (failed) errors.push({ turn, tool: toolLabel(call.name), text: failed });
    const http = /^HTTP (\d{3})\b/.exec(content);
    note({
      from: "Agent",
      to: "Tools",
      label: toolLabel(call.name),
      request: [`${call.name}(…)`, ...body(call.args)].join("\n"),
      response:
        result === undefined
          ? "(no result recorded)"
          : body(JSON.stringify({ content: [{ type: "text", text: content }] }))
              .join("\n")
              .trim() || content,
      status:
        result === undefined ? 0 : http ? Number(http[1]) : toolStatus(content),
    });
  }
}

/**
 * Load a conversation the demo has had with Sam, by its task id: its chat and
 * the agent's tool calls from Introspection, a run still going followed, and
 * Sam's next message continuing it. The wire behind each tool call is not
 * recorded, so it is not restored.
 */
export async function join(taskId: string) {
  if (run().busy) return;
  reset();
  const r = run();
  startRecording();
  const account = serviceAccount();
  if (!account) {
    r.error = notSetUp();
    return;
  }
  const epoch = r.epoch;
  try {
    r.runner = await (
      await IntrospectionClient.fromServiceAccount(account)
    )
      .runtimes(RUNTIME)
      .run({ identity: { user_id: SAM_USER_ID } });
    const task = await r.runner.tasks.get(taskId);
    r.taskId = taskId;
    const lines = await history(r.runner, taskId);
    if (r.epoch !== epoch) return;
    r.chat = lines.map(({ from, text }) => ({ from, text }));
    await toolCalls(r.runner, taskId, lines, r.toolErrors);
    if (r.epoch !== epoch) return;
    setTurn(r.chat.length);
    // Follow a run only while one is live; an idle conversation's sandbox is
    // gone, and Sam's next message starts a fresh one.
    const active = task.metadata?.active_run_id as string | undefined;
    if (active)
      void drive(r, epoch, async () => ({
        runId: active,
        stream: r.runner!.tasks.runs.stream(taskId, active) as Stream,
      }));
  } catch (err) {
    if (r.epoch === epoch)
      r.error = `Could not load ${taskId}: ${err instanceof Error ? err.message : String(err)}`;
  }
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
  const response = await fetchRetrying(
    `${ACME_APPROVAL_URL}/ps/approvals/${id}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", [ACTOR_HEADER]: who },
      body: JSON.stringify({
        code: email.code,
        verdict,
        ...(budgetDollars ? { budget: budgetDollars } : {}),
      }),
    },
  );
  if (!response.ok) {
    const problem = (await response.json().catch(() => ({}))) as {
      detail?: string;
    };
    r.error = `Acme refused the decision (${response.status})${problem.detail ? `: ${problem.detail}` : ""}`;
    return;
  }
  r.decided.push(index);
  r.decidedAt = Date.now();
}
