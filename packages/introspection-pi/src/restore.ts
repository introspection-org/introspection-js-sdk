/**
 * Restore a Pi coding-agent session from its recorded GenAI telemetry so the
 * next request repeats the provider request prefix byte for byte, and a
 * restore inside the provider's prompt-cache lifetime reads the whole
 * previous prompt from cache.
 *
 * Telemetry carries the conversation but not the system message Pi opens its
 * transcript with (the prompt as named sections, plus the tool loadout). The
 * restore rebuilds that message the way Pi's first run does, puts it first,
 * then appends the recorded messages.
 */

import * as piAi from "@earendil-works/pi-ai";
import type { Message, SystemMessage, Tool } from "@earendil-works/pi-ai";
import type { InputMessage } from "@introspection-sdk/types";
import { inputMessagesToMessages } from "./convert.js";
import {
  sessionInternals,
  type SystemPromptOptions,
} from "./session-internals.js";

/** The slice of a pi-coding-agent `AgentSession` a restore uses. */
export interface RestorableSession {
  agent: { state: { tools: Tool[]; messages: readonly unknown[] } };
  sessionManager: {
    appendMessage(message: Message): string;
    appendCompaction(
      summary: string,
      firstKeptEntryId: string | null,
      tokensBefore: number,
    ): string;
  };
  getActiveToolNames(): string[];
  setActiveToolsByName(toolNames: string[]): void;
  refreshContext(): void;
}

/** The tools one recorded chat request declared, from its span. */
export interface RecordedToolLoadout {
  /** How many messages the request's `gen_ai.input.messages` held. */
  inputMessageCount: number;
  /** The tool names its `gen_ai.tool.definitions` lists, in order. */
  toolNames: readonly string[];
}

export interface RestoreSessionOptions {
  /**
   * The loadout of each recorded chat request on the restored history,
   * oldest first: the requests whose input opens as `inputMessages` does,
   * so after a compaction only those since it. The first is what the head
   * declares; a later one that differs becomes a tool change where the live
   * session made it. Without them the head declares the session's current
   * tools, which matches only a conversation whose tools never changed.
   */
  toolLoadouts?: readonly RecordedToolLoadout[];
  /**
   * Wraps the `before_agent_start` handlers that render the head. An
   * extension rendering a dated section reads its clock here: pin that clock
   * to the conversation's start, so the head keeps the date the provider
   * cached and the next run adds a date patch, as a live session does when
   * it crosses midnight.
   */
  aroundHead?: <T>(build: () => Promise<T>) => Promise<T>;
}

// Namespace access: these exist only in Pi >= 0.86, an older peer still links.
const transcript: Partial<
  Pick<typeof piAi, "getToolStateChanges" | "toToolDeclaration">
> = piAi;

/**
 * Append the recorded conversation to an empty `session`, behind the system
 * message its first run would have opened with, and refresh its context.
 * Create `session` under the original session's id (`SessionManager`'s
 * `id` option): OpenAI's `prompt_cache_key` and OpenRouter's session
 * affinity are derived from it, so another id sends another request.
 * `inputMessages` is the latest chat span's `gen_ai.input.messages` followed
 * by its `gen_ai.output.messages`. Returns the number of messages in the
 * restored context.
 */
export async function restoreSession(
  session: RestorableSession,
  inputMessages: readonly InputMessage[],
  options: RestoreSessionOptions = {},
): Promise<number> {
  const internals = sessionInternals(session);
  const { getToolStateChanges, toToolDeclaration } = transcript;
  if (!getToolStateChanges || !toToolDeclaration) {
    throw new Error("restoreSession needs @earendil-works/pi-ai >= 0.86");
  }
  if (session.agent.state.messages.length > 0) {
    throw new Error("restoreSession: the session already holds a conversation");
  }

  const active = session.getActiveToolNames();
  const base = internals.baseOptions();
  const around = options.aroundHead ?? ((build) => build());
  const runOptions = await around(() =>
    internals.beforeAgentStart({ ...base }),
  );
  // As Pi's run start: the live loadout unless a handler chose the tools.
  const headTools =
    options.toolLoadouts?.[0]?.toolNames ??
    (sameNames(runOptions.selectedTools, base.selectedTools)
      ? active
      : runOptions.selectedTools);

  const written: Message[] = [];
  const append = (message: Message) => {
    session.sessionManager.appendMessage(message);
    written.push(message);
  };
  let declared: Tool[] = [];
  // The system message declaring `names`, as Pi's agent loop declares a
  // loadout: prompt sections patched, then the tool delta.
  const declare = (
    names: readonly string[],
    prompt: SystemPromptOptions,
  ): SystemMessage | undefined => {
    const patch = internals.prepareLoadout(
      { ...prompt, selectedTools: [...names] },
      written,
    );
    const tools = session.agent.state.tools.map(toToolDeclaration);
    const { toolsAdded, toolsRemoved } = getToolStateChanges(declared, tools);
    declared = tools;
    if (!patch && toolsAdded.length === 0 && toolsRemoved.length === 0) {
      return undefined;
    }
    return {
      ...(patch ?? { role: "system", content: "", timestamp: Date.now() }),
      ...(toolsAdded.length > 0 ? { toolsAdded } : {}),
      ...(toolsRemoved.length > 0 ? { toolsRemoved } : {}),
    };
  };

  const head = declare(headTools, runOptions);
  if (head) append(head);

  let history = inputMessages;
  let offset = 0;
  const summary = leadingCompaction(inputMessages);
  if (summary !== null) {
    // The boundary's kept entries are not recorded, so the compaction keeps
    // everything after it (Pi's own fallback).
    session.sessionManager.appendCompaction(summary, null, 0);
    history = inputMessages.slice(1);
    offset = 1;
  }

  let start = 0;
  const loadouts = options.toolLoadouts ?? [];
  for (let i = 1; i < loadouts.length; i++) {
    const loadout = loadouts[i]!;
    const names = declared.map((tool) => tool.name);
    if (sameNames(loadout.toolNames, names)) continue;
    // Pi declares a change ahead of the request's first new user message (a
    // run's prompt), else after its tool results: the messages that follow
    // the previous request's response.
    const end = loadout.inputMessageCount;
    let at = end;
    for (let j = loadouts[i - 1]!.inputMessageCount + 1; j < end; j++) {
      if (inputMessages[j]?.role === "user") {
        at = j;
        break;
      }
    }
    at -= offset;
    if (at < start || at > history.length) continue;
    for (const message of inputMessagesToMessages(history.slice(start, at))) {
      append(message);
    }
    start = at;
    const update = declare(loadout.toolNames, runOptions);
    if (update) append(update);
  }
  for (const message of inputMessagesToMessages(history.slice(start))) {
    append(message);
  }

  // Back to the session's own loadout; the next run declares any difference.
  if (!sameNames(session.getActiveToolNames(), active)) {
    session.setActiveToolsByName(active);
  }
  session.refreshContext();
  return session.agent.state.messages.length;
}

/** The summary of a recorded history that opens with a compaction, else null. */
function leadingCompaction(messages: readonly InputMessage[]): string | null {
  const first = messages[0];
  if (first?.role !== "user") return null;
  const part = first.parts.find((p) => p.type === "compaction");
  return part && "content" in part && typeof part.content === "string"
    ? part.content
    : null;
}

function sameNames(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name, i) => name === b[i]);
}
