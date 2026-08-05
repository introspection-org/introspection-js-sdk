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
 *   1. `~/.introspection/telemetry.json` — the recorded install-time decision.
 *      An enabled stored grant is always required.
 *   2. `INTROSPECTION_PLUGIN_TELEMETRY` — a session-local override that may
 *      narrow or disable the stored grant, never create or widen one.
 *   3. Disabled.
 *
 * The override is deliberately one-way. An "off" switch that a user cannot
 * reach in the moment is not a real off switch, while enabling or broadening
 * capture remains an explicit persisted-consent operation.
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
 * The three names are the same in the config, the `--telemetry` flag, and the
 * installer prompt, so there is one vocabulary rather than three.
 *
 * - `off` — capture nothing. Equivalent to disabled; present so a config can
 *   record "explicitly declined" distinctly from "never asked".
 * - `on` — structure and measurements only: turn and tool span shapes,
 *   timings, tool *names*, models, token counts. No prompts, no completions, no
 *   tool arguments, no tool output. The floor.
 * - `full` — the above plus message content and tool payloads. Needed to judge
 *   a trajectory the way the eval harness does, and only ever reached by an
 *   explicit choice at the consent prompt.
 */
export type ContentCapture = "off" | "on" | "full";

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
  content: "off",
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
      return { enabled: false, content: "off" };
    // `metadata` is this level's earlier name, still accepted so a config or a
    // habit from before the rename keeps working.
    case "on":
    case "1":
    case "true":
    case "yes":
    case "metadata":
      return { enabled: true, content: "on" };
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
      : obj.content === "on" || obj.content === "metadata"
        ? "on"
        : "off";

  const targets = Array.isArray(obj.targets)
    ? obj.targets.filter(
        (t): t is CaptureHost => t === "claude-code" || t === "codex",
      )
    : [];

  return {
    version: TELEMETRY_CONFIG_VERSION,
    enabled: obj.enabled === true && content !== "off",
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
  if (!stored.enabled) return stored;

  // Environment configuration may disable or narrow a stored grant, but it is
  // not a consent surface of its own. In particular, `full` must never promote
  // a missing or metadata-only grant into content capture.
  const content =
    override.content === "full" && stored.content !== "full"
      ? stored.content
      : (override.content ?? stored.content);
  return {
    ...stored,
    enabled: content !== "off",
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
