/**
 * What the real agent did in one eval trial, as the page's events: read from
 * `introspection tasks stream` (JSONL AG-UI events) while the trial runs, or
 * from the trial's trajectory.json once it has finished. Pure, or reads files;
 * the spawning lives in platform-runner.ts.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { SpawnSpec, Step } from "./platform-evals";

export type TrialEventType =
  | "bank.served"
  | "bank.marked"
  | "memory.read"
  | "memory.written"
  | "host.planned";

export interface TrialEvent {
  /** Identifies the event within its trial, so a stream and a trajectory never show it twice. */
  key: string;
  type: TrialEventType;
  summary: string;
  data: Record<string, unknown>;
}

const PLAN_PREVIEW = 300;
const BANK_TOOL = /^mcp_(trivia-bank)_([a-z_]+?)(?:_[0-9a-f]{6,})?$/;
const MARKING_TOOLS = new Set(["submit_round", "round_summary", "scoreboard"]);
const MEMORY_FILE = /(^|\/)memories\/MEMORY\.md$/;

/** The task id `eval run` prints for its trial, such as `task 01a2… is queued on the org's `eval` lane`. */
export function parseTaskId(output: string): string | null {
  return /\btask ([0-9a-f]{8}-[0-9a-f-]{27,})\b/i.exec(output)?.[1] ?? null;
}

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // Arguments still streaming in, or not JSON: nothing to show yet.
    return {};
  }
}

/** A tool result as text: a Pi result is `{content: [{type: "text", text}]}`, serialized or not. */
function resultText(raw: unknown): string {
  let value = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      return value as string;
    }
  }
  if (typeof value === "string") return value;
  const content = Array.isArray(value)
    ? value
    : (value as { content?: unknown } | null)?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof (part as { text?: unknown })?.text === "string"
            ? (part as { text: string }).text
            : "",
      )
      .join("");
  return typeof raw === "string" ? raw : JSON.stringify(raw);
}

function bankSummary(tool: string, args: Record<string, unknown>): string {
  const filter = ["genre", "difficulty", "region"]
    .filter((name) => args[name] !== undefined)
    .map((name) => `${name} ${String(args[name])}`);
  if (typeof args.count === "number") filter.push(`${args.count} questions`);
  if (Array.isArray(args.answers))
    filter.push(`${args.answers.length} answers`);
  if (Array.isArray(args.names)) filter.push(`${args.names.length} teams`);
  return filter.length ? `${tool}: ${filter.join(", ")}` : tool;
}

/**
 * The event a finished tool call stands for, or none. A memory read waits for
 * its result (`result` undefined until then); everything else needs only the
 * arguments.
 */
export function toolCallEvent(
  id: string,
  name: string,
  args: Record<string, unknown>,
  result?: string,
): TrialEvent | null {
  const bank = BANK_TOOL.exec(name);
  if (bank) {
    const [, server, tool] = bank;
    return {
      key: `tool:${id}`,
      type: MARKING_TOOLS.has(tool) ? "bank.marked" : "bank.served",
      summary: bankSummary(tool, args),
      data: { server, tool, arguments: args },
    };
  }
  const file = typeof args.path === "string" ? args.path : "";
  if (!MEMORY_FILE.test(file)) return null;
  if (name === "read") {
    if (result === undefined) return null;
    return {
      key: `tool:${id}`,
      type: "memory.read",
      summary:
        id === "toolu_recipe_memory_read"
          ? "The runtime loaded the venue's notes"
          : "Read the venue's notes",
      data: { path: file, file: result },
    };
  }
  if (name === "write")
    return {
      key: `tool:${id}`,
      type: "memory.written",
      summary: "Wrote the venue's notes",
      data: {
        path: file,
        file: typeof args.content === "string" ? args.content : null,
      },
    };
  if (name === "edit")
    return {
      key: `tool:${id}`,
      type: "memory.written",
      summary: "Edited the venue's notes",
      data: { path: file, edit: args },
    };
  return null;
}

export function plannedEvent(text: string): TrialEvent | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return {
    key: "planned",
    type: "host.planned",
    summary: trimmed.split("\n").find(Boolean)!.slice(0, 120),
    data: { file: trimmed.slice(0, PLAN_PREVIEW) },
  };
}

interface Call {
  name: string;
  args: string;
  done: boolean;
}

/** Folds the JSONL lines of one `tasks stream` into events, as they arrive. */
export class StreamMapper {
  /** The last AG-UI event id seen, to reattach with `--since`. */
  cursor = 0;
  runId: string | null = null;
  /** Whether the run finished on the stream (RUN_FINISHED or RUN_ERROR). */
  ended = false;
  private calls = new Map<string, Call>();
  private texts = new Map<string, string>();
  private lastText = "";
  private shown = new Set<string>();

  push(line: string): TrialEvent[] {
    if (!line.trim()) return [];
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return [];
    }
    if (typeof frame.run_id === "string") this.runId = frame.run_id;
    const id = Number(frame.event_id);
    if (Number.isFinite(id)) this.cursor = Math.max(this.cursor, id);
    const event = (frame.event ?? frame) as Record<string, unknown>;
    return this.apply(event).filter((item) => {
      if (this.shown.has(item.key)) return false;
      this.shown.add(item.key);
      return true;
    });
  }

  private apply(event: Record<string, unknown>): TrialEvent[] {
    const str = (key: string) =>
      typeof event[key] === "string" ? (event[key] as string) : "";
    switch (event.type) {
      case "TOOL_CALL_START":
        if (!this.calls.has(str("toolCallId")))
          this.calls.set(str("toolCallId"), {
            name: str("toolCallName"),
            args: "",
            done: false,
          });
        return [];
      case "TOOL_CALL_ARGS": {
        const call = this.calls.get(str("toolCallId"));
        if (call && !call.done) call.args += str("delta");
        return [];
      }
      case "TOOL_CALL_END":
        return this.callDone(str("toolCallId"));
      case "TOOL_CALL_RESULT":
        return this.result(str("toolCallId"), event.content);
      case "TEXT_MESSAGE_START":
        this.texts.set(str("messageId"), "");
        return [];
      case "TEXT_MESSAGE_CONTENT":
      case "TEXT_MESSAGE_CHUNK":
        this.texts.set(
          str("messageId"),
          (this.texts.get(str("messageId")) ?? "") + str("delta"),
        );
        return [];
      case "TEXT_MESSAGE_END": {
        const text = this.texts.get(str("messageId")) ?? "";
        if (text.trim()) this.lastText = text;
        return [];
      }
      case "MESSAGES_SNAPSHOT":
        return this.snapshot(event.messages);
      case "RUN_FINISHED":
      case "RUN_ERROR": {
        this.ended = true;
        const planned = plannedEvent(this.lastText);
        return planned ? [planned] : [];
      }
      default:
        return [];
    }
  }

  private callDone(toolCallId: string): TrialEvent[] {
    const call = this.calls.get(toolCallId);
    if (!call) return [];
    call.done = true;
    const event = toolCallEvent(toolCallId, call.name, parseArgs(call.args));
    return event ? [event] : [];
  }

  private result(toolCallId: string, content: unknown): TrialEvent[] {
    const call = this.calls.get(toolCallId);
    if (!call) return [];
    const event = toolCallEvent(
      toolCallId,
      call.name,
      parseArgs(call.args),
      resultText(content),
    );
    return event ? [event] : [];
  }

  /** A reattach behind the replay buffer gets the whole run as one snapshot. */
  private snapshot(messages: unknown): TrialEvent[] {
    if (!Array.isArray(messages)) return [];
    const events: TrialEvent[] = [];
    for (const message of messages as Record<string, unknown>[]) {
      if (message.role === "assistant") {
        if (typeof message.content === "string" && message.content.trim())
          this.lastText = message.content;
        for (const call of (message.toolCalls ?? []) as {
          id: string;
          function: { name: string; arguments: string };
        }[]) {
          this.calls.set(call.id, {
            name: call.function.name,
            args: call.function.arguments,
            done: false,
          });
          events.push(...this.callDone(call.id));
        }
      } else if (
        message.role === "tool" &&
        typeof message.toolCallId === "string"
      ) {
        events.push(...this.result(message.toolCallId, message.content));
      }
    }
    return events;
  }
}

/** The trial's ATIF trajectory, as harbor writes it under the run folder. */
export function trajectoryFile(runFolder: string): string | null {
  const harbor = path.join(runFolder, "harbor");
  if (!existsSync(harbor)) return null;
  for (const name of readdirSync(harbor)) {
    const file = path.join(harbor, name, "agent", "trajectory.json");
    if (existsSync(file)) return file;
  }
  return null;
}

interface AtifStep {
  source?: string;
  message?: unknown;
  tool_calls?: {
    tool_call_id: string;
    function_name: string;
    arguments?: unknown;
  }[];
  observation?: { results?: { source_call_id?: string; content?: unknown }[] };
}

/** The same events, built from a finished trial's trajectory.json. */
export function trajectoryEvents(file: string): TrialEvent[] {
  const trajectory = JSON.parse(readFileSync(file, "utf8")) as {
    steps?: AtifStep[];
  };
  const steps = trajectory.steps ?? [];
  const results = new Map<string, string>();
  for (const step of steps)
    for (const result of step.observation?.results ?? [])
      if (result.source_call_id)
        results.set(result.source_call_id, resultText(result.content));
  const events: TrialEvent[] = [];
  let lastText = "";
  for (const step of steps) {
    if (step.source !== "agent") continue;
    if (typeof step.message === "string" && step.message.trim())
      lastText = step.message;
    for (const call of step.tool_calls ?? []) {
      const event = toolCallEvent(
        call.tool_call_id,
        call.function_name,
        parseArgs(call.arguments),
        results.get(call.tool_call_id),
      );
      if (event) events.push(event);
    }
  }
  const planned = plannedEvent(lastText);
  if (planned) events.push(planned);
  return events;
}

/**
 * `introspection tasks stream` for one trial's task, with the same env as its
 * `eval run`: the key only as INTROSPECTION_TOKEN, never an argument.
 */
export function streamSpec(
  taskId: string,
  recipeDir: string,
  credentials: { token: string; apiBaseUrl: string },
  resume: { runId: string | null; since: number },
  baseEnv: Record<string, string | undefined> = process.env,
): SpawnSpec {
  const args = ["tasks", "stream", taskId, "--non-interactive"];
  if (resume.runId) args.push("--run", resume.runId);
  if (resume.since > 0) args.push("--since", String(resume.since));
  return {
    command: "introspection",
    args,
    options: {
      cwd: recipeDir,
      env: {
        ...baseEnv,
        INTROSPECTION_TOKEN: credentials.token,
        INTROSPECTION_API_BASE_URL: credentials.apiBaseUrl,
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  };
}

/** What a trial's event carries besides its own data, so the page can file it. */
export function tagged(step: Step, taskId: string, event: TrialEvent) {
  return {
    ...event.data,
    run: step.run,
    venue: step.venue,
    venue_label: step.venue_label,
    night: step.night,
    variant: step.variant,
    task_id: taskId,
    key: event.key,
  };
}
