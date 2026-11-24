/**
 * What the real agent did in one eval trial, as the page's events: read from
 * the trial's trajectory.json once it has finished. Pure, or reads files.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import type { Step } from "./platform-evals";

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

const PLAN_PREVIEW = 2000;
const BANK_TOOL = /^mcp_(trivia-bank)_([a-z_]+?)(?:_[0-9a-f]{6,})?$/;
const MARKING_TOOLS = new Set(["submit_round", "round_summary", "scoreboard"]);
const MEMORY_FILE = /(^|\/)memories\/MEMORY\.md$/;

function parseArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    // Not JSON: nothing to show.
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

/** A missing notes file: the agent's read on a venue's first visit. */
const NO_FILE = /ENOENT|no such file/i;

/** A tool error's first line, shortened. */
function shortError(text: string): string {
  const line = text.trim().split("\n")[0];
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/**
 * The event a finished tool call stands for, or none. A memory read needs its
 * result; everything else needs only the arguments. `isError` marks a result
 * the tool reported as an error.
 */
export function toolCallEvent(
  id: string,
  name: string,
  args: Record<string, unknown>,
  result?: string,
  isError = false,
): TrialEvent | null {
  const bank = BANK_TOOL.exec(name);
  if (bank) {
    const [, server, tool] = bank;
    return {
      key: `tool:${id}`,
      type: MARKING_TOOLS.has(tool) ? "bank.marked" : "bank.served",
      summary: bankSummary(tool, args),
      data: {
        server,
        tool,
        arguments: args,
        ...(isError && result ? { error: shortError(result) } : {}),
      },
    };
  }
  const file = typeof args.path === "string" ? args.path : "";
  if (!MEMORY_FILE.test(file)) return null;
  if (name === "read") {
    if (result === undefined) return null;
    if (!result.trim() || (isError && NO_FILE.test(result)))
      return {
        key: `tool:${id}`,
        type: "memory.read",
        summary: "Loading memory · none yet — first visit",
        data: { path: file, file: "", first_visit: true },
      };
    if (isError)
      return {
        key: `tool:${id}`,
        type: "memory.read",
        summary: "Loading memory failed",
        data: { path: file, file: "", error: shortError(result) },
      };
    return {
      key: `tool:${id}`,
      type: "memory.read",
      summary:
        id === "toolu_recipe_memory_read"
          ? "Loading memory (by the runtime)"
          : "Loading memory",
      data: { path: file, file: result },
    };
  }
  if (name === "write")
    return {
      key: `tool:${id}`,
      type: "memory.written",
      summary: "Saving memory",
      data: {
        path: file,
        file: typeof args.content === "string" ? args.content : null,
      },
    };
  if (name === "edit")
    return {
      key: `tool:${id}`,
      type: "memory.written",
      summary: "Saving memory (an edit)",
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
  observation?: {
    results?: {
      source_call_id?: string;
      content?: unknown;
      extra?: { is_error?: boolean };
    }[];
  };
}

/** The same events, built from a finished trial's trajectory.json. */
export function trajectoryEvents(file: string): TrialEvent[] {
  const trajectory = JSON.parse(readFileSync(file, "utf8")) as {
    steps?: AtifStep[];
  };
  const steps = trajectory.steps ?? [];
  const results = new Map<string, string>();
  const errors = new Set<string>();
  for (const step of steps)
    for (const result of step.observation?.results ?? []) {
      if (!result.source_call_id) continue;
      results.set(result.source_call_id, resultText(result.content));
      if (result.extra?.is_error) errors.add(result.source_call_id);
    }
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
        errors.has(call.tool_call_id),
      );
      if (event) events.push(event);
    }
  }
  const planned = plannedEvent(lastText);
  if (planned) events.push(planned);
  return events;
}

/** What a trial's event carries besides its own data, so the page can file it. */
export function tagged(step: Step, event: TrialEvent) {
  return {
    ...event.data,
    run: step.run,
    venue: step.venue,
    venue_label: step.venue_label,
    night: step.night,
    variant: step.variant,
    key: event.key,
  };
}
