/**
 * What the host did in one eval trial, as the page's steps: built from the
 * step list its verifier wrote into the result file, read from the GenAI
 * spans the runtime keeps in the sandbox. Pure.
 */

export type TrialEventType =
  | "bank.served"
  | "bank.marked"
  | "memory.read"
  | "memory.written"
  | "host.planned"
  | "host.tool";

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

/**
 * The memory the runtime loaded before the night's first turn: the notes the
 * night before left, since the load is in no span the verifier can read.
 */
export function loadedMemory(notes: string): TrialEvent {
  return {
    key: "runtime:memory",
    type: "memory.read",
    summary: "Loading memory (by the runtime)",
    data: { path: "memories/MEMORY.md", file: notes },
  };
}

/** One tool call as the verifier wrote it: arguments and result already cut short. */
interface HostCall {
  id?: unknown;
  name?: unknown;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
}

/** The night's steps from the result file's `steps` and `plan`; none when it has neither. */
export function hostEvents(steps: unknown, plan: unknown): TrialEvent[] {
  const events: TrialEvent[] = [];
  for (const [index, raw] of (Array.isArray(steps) ? steps : []).entries()) {
    const call = (raw ?? {}) as HostCall;
    if (typeof call.name !== "string") continue;
    const event = toolCallEvent(
      typeof call.id === "string" ? call.id : String(index),
      call.name,
      parseArgs(call.arguments),
      typeof call.result === "string" ? call.result : undefined,
      call.error === true,
    );
    events.push(
      event ?? {
        key: `tool:${typeof call.id === "string" ? call.id : index}`,
        type: "host.tool",
        summary: call.name,
        data: { tool: call.name, arguments: parseArgs(call.arguments) },
      },
    );
  }
  const planned = plannedEvent(typeof plan === "string" ? plan : "");
  if (planned) events.push(planned);
  return events;
}
