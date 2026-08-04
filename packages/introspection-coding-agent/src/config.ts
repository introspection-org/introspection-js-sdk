/**
 * Consent state and capture settings.
 *
 * Capture is **off unless a recorded opt-in says otherwise**. There is no
 * implicit enablement: a missing, unreadable, or malformed config file resolves
 * to disabled, and every failure mode in this module resolves the same way. The
 * user grants consent once, at `introspection plugin install`, and the CLI
 * writes the result here.
 *
 * Precedence, highest first:
 *
 *   1. `INTROSPECTION_PLUGIN_TELEMETRY` — an env override, so a session can be
 *      turned off (or on, for a support repro) without rewriting the file.
 *   2. `~/.introspection/telemetry.json` — the recorded install-time decision.
 *   3. Disabled.
 *
 * The override is deliberately symmetric. An "off" switch that a user cannot
 * reach in the moment is not a real off switch, and an "on" switch that
 * requires re-running an installer makes support repros hostile.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

/**
 * How much of a session's content leaves the machine.
 *
 * This is the privacy dial, and it is separate from the on/off decision: a user
 * who wants the platform to see that a workflow stalled does not necessarily
 * want it to see the source code they pasted into the prompt.
 *
 * - `none` — capture nothing. Equivalent to disabled; present so a config can
 *   record "explicitly declined" distinctly from "never asked".
 * - `metadata` — structure and measurements only: turn and tool span shapes,
 *   timings, tool *names*, models, token counts. No prompts, no completions, no
 *   tool arguments, no tool output. The safe default.
 * - `full` — the above plus message content and tool payloads. Needed to judge
 *   a trajectory the way the eval harness does, and only ever reached by an
 *   explicit choice at the consent prompt.
 */
export type ContentCapture = "none" | "metadata" | "full";

/** Coding-agent hosts this package can capture. */
export type CaptureHost = "claude-code" | "codex";

/** The persisted opt-in decision. */
export interface TelemetryConfig {
  /** On-disk schema version, so a later CLI can migrate rather than misread. */
  version: number;
  /** Whether the user opted in. */
  enabled: boolean;
  /** How much content the user agreed to send. */
  content: ContentCapture;
  /** Hosts the user opted in for, from `--target`. */
  targets: CaptureHost[];
  /** When consent was recorded (ISO-8601), for audit and re-prompt decisions. */
  granted_at?: string;
}

/** Current on-disk schema version for `telemetry.json`. */
export const TELEMETRY_CONFIG_VERSION = 1;

const DISABLED: TelemetryConfig = {
  version: TELEMETRY_CONFIG_VERSION,
  enabled: false,
  content: "none",
  targets: [],
};

/** Path to the recorded consent decision. */
export function telemetryConfigPath(home: string = homedir()): string {
  return join(home, ".introspection", "telemetry.json");
}

/**
 * Read the `INTROSPECTION_PLUGIN_TELEMETRY` override.
 *
 * Accepts the shapes a person actually types (`on`/`off`, `1`/`0`,
 * `true`/`false`), plus a content level directly (`metadata`, `full`) so the
 * dial is reachable from the env too. Anything unrecognized returns `undefined`
 * and falls through to the file rather than guessing — a typo'd override must
 * not silently mean "on".
 */
export function readTelemetryOverride(
  raw: string | undefined = process.env.INTROSPECTION_PLUGIN_TELEMETRY,
): Partial<TelemetryConfig> | undefined {
  if (raw === undefined) return undefined;
  switch (raw.trim().toLowerCase()) {
    case "off":
    case "0":
    case "false":
    case "no":
    case "none":
      return { enabled: false, content: "none" };
    case "on":
    case "1":
    case "true":
    case "yes":
      // "on" alone does not widen content. It re-enables at whatever level was
      // consented to; the file supplies that, and metadata is the floor.
      return { enabled: true };
    case "metadata":
      return { enabled: true, content: "metadata" };
    case "full":
      return { enabled: true, content: "full" };
    default:
      return undefined;
  }
}

function parseConfig(text: string): TelemetryConfig {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== "object" || raw === null) return DISABLED;
  const obj = raw as Record<string, unknown>;

  // An unknown schema version means a newer CLI wrote a shape this build cannot
  // interpret. Refuse it rather than partially reading it: misreading a consent
  // record in the permissive direction is the one failure that matters here.
  if (obj.version !== TELEMETRY_CONFIG_VERSION) return DISABLED;

  const content: ContentCapture =
    obj.content === "full"
      ? "full"
      : obj.content === "metadata"
        ? "metadata"
        : "none";

  const targets = Array.isArray(obj.targets)
    ? obj.targets.filter(
        (t): t is CaptureHost => t === "claude-code" || t === "codex",
      )
    : [];

  return {
    version: TELEMETRY_CONFIG_VERSION,
    enabled: obj.enabled === true && content !== "none",
    content,
    targets,
    granted_at: typeof obj.granted_at === "string" ? obj.granted_at : undefined,
  };
}

/**
 * Resolve the effective consent state.
 *
 * Never throws and never rejects: a missing file, a permission error, or
 * malformed JSON all resolve to disabled, because the alternative — a capture
 * path that reports an error and keeps running — is how telemetry ships without
 * consent.
 */
export async function resolveTelemetryConfig(
  home: string = homedir(),
): Promise<TelemetryConfig> {
  let stored: TelemetryConfig = DISABLED;
  try {
    stored = parseConfig(await readFile(telemetryConfigPath(home), "utf8"));
  } catch {
    stored = DISABLED;
  }

  const override = readTelemetryOverride();
  if (!override) return stored;

  if (override.enabled === false) return DISABLED;

  // An override can re-enable and can *narrow* content, but it cannot widen
  // past what was consented to unless it names a level explicitly. `on` with no
  // stored consent lands on metadata — the floor — never on `full`.
  const content =
    override.content ?? (stored.enabled ? stored.content : "metadata");
  return {
    ...stored,
    enabled: content !== "none",
    content,
  };
}

/** Whether a given host is covered by the recorded consent. */
export function coversHost(
  config: TelemetryConfig,
  host: CaptureHost,
): boolean {
  if (!config.enabled) return false;
  // An empty target list means consent was recorded without host scoping; treat
  // it as covering the hosts the plugin installs into rather than nothing, so a
  // config written by an older CLI still functions.
  return config.targets.length === 0 || config.targets.includes(host);
}
