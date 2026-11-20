/**
 * The `AgentSession` internals a restore needs. Each one is a step of Pi's own
 * run start (`AgentSession._prepareRun` in `@earendil-works/pi-coding-agent`),
 * which builds the transcript's leading system message; Pi exports none of
 * them. They are resolved here, and only here, so a Pi release that renames
 * one fails the restore with its name instead of restoring a different prompt.
 */

import type { SystemMessage } from "@earendil-works/pi-ai";

/** Pi's `BuildSystemPromptOptions`, as far as a restore reads them. */
export interface SystemPromptOptions {
  selectedTools: string[];
  [key: string]: unknown;
}

interface PiAgentSessionInternals {
  _baseSystemPromptOptions?: SystemPromptOptions;
  _extensionRunner?: {
    emitBeforeAgentStart(
      trigger: object,
      options: SystemPromptOptions,
    ): Promise<{ systemPromptOptions: SystemPromptOptions }>;
  };
  _preparePromptAndToolLoadout?: (
    options: SystemPromptOptions,
    messages: readonly unknown[],
  ) => SystemMessage | undefined;
}

export interface SessionInternals {
  /** The session's prompt options before any run's `before_agent_start`. */
  baseOptions(): SystemPromptOptions;
  /** Run the `before_agent_start` handlers, as a run started by a prompt does. */
  beforeAgentStart(options: SystemPromptOptions): Promise<SystemPromptOptions>;
  /**
   * Apply `options.selectedTools` as the executable loadout and return the
   * system message patching the prompt sections of `messages`.
   */
  prepareLoadout(
    options: SystemPromptOptions,
    messages: readonly unknown[],
  ): SystemMessage | undefined;
}

/** Resolve the internals on a live `AgentSession`, or throw naming the one that is missing. */
export function sessionInternals(session: object): SessionInternals {
  const pi = session as PiAgentSessionInternals;
  const missing = [
    pi._baseSystemPromptOptions ? null : "_baseSystemPromptOptions",
    typeof pi._extensionRunner?.emitBeforeAgentStart === "function"
      ? null
      : "_extensionRunner.emitBeforeAgentStart",
    typeof pi._preparePromptAndToolLoadout === "function"
      ? null
      : "_preparePromptAndToolLoadout",
  ].filter((name): name is string => name !== null);
  if (missing.length > 0) {
    throw new Error(
      `restoreSession: this Pi AgentSession has no ${missing.join(", ")}; ` +
        "the restore mirrors AgentSession._prepareRun and needs updating for this Pi release",
    );
  }
  const runner = pi._extensionRunner!;
  const prepare = pi._preparePromptAndToolLoadout!.bind(session);
  return {
    baseOptions: () => pi._baseSystemPromptOptions!,
    beforeAgentStart: async (options) =>
      (
        await runner.emitBeforeAgentStart(
          { messageType: "user", prompt: "", images: [] },
          options,
        )
      ).systemPromptOptions,
    prepareLoadout: (options, messages) => prepare(options, messages),
  };
}
