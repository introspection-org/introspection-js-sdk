/**
 * Host identification and per-host transcript locations.
 *
 * Two jobs the normalizer deliberately does not do:
 *
 * 1. **Where the transcripts live.** `@letta-ai/trajectory` exposes
 *    `listTrajectories()` for discovery, but the hook path already knows the
 *    exact file — the host hands it over — so this module only needs the shape
 *    of a session id, not a directory walk.
 * 2. **Which host version produced it.** The normalized record set is a
 *    deliberately host-neutral contract: `MetaRecord` carries `source`, `cwd`,
 *    `git_branch`, and `model`, and drops everything host-specific. That is
 *    right for normalization and wrong for us, because "which Codex/Claude Code
 *    version was this?" is exactly the correlation the platform wants. So we
 *    read that one field back out of the raw transcript ourselves.
 *
 * Reading it from the transcript beats shelling out to `claude --version`: it is
 * the version that actually produced *these* records rather than whatever is on
 * PATH now, and it costs no subprocess on a latency-sensitive hook path.
 */
import type { CaptureHost } from "./config.js";

/** Host-specific metadata recovered from a raw transcript. */
export interface HostInfo {
  /** Which coding agent produced the transcript. */
  host: CaptureHost;
  /** The host's own version string, when the transcript records one. */
  hostVersion?: string;
  /** How the session was launched, when the host records it. */
  entrypoint?: string;
}

/**
 * How many leading lines to scan for host metadata.
 *
 * Claude Code stamps `version` on every conversational record and Codex puts
 * `cli_version` in its leading `session_meta`, so the answer is always within
 * the first handful of lines. The bound matters because an incremental chunk can
 * be large and this runs inside a hook the user is waiting on.
 */
const METADATA_SCAN_LINES = 40;

function firstString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Extract host metadata from raw transcript text.
 *
 * Tolerant by construction: transcripts are append-only JSONL that can be
 * truncated mid-write, and a chunk read from a byte offset can begin mid-line.
 * Unparseable lines are skipped rather than treated as failure, and a transcript
 * that yields nothing returns just the host — a missing version degrades the
 * correlation, it does not invalidate the trace.
 */
export function readHostInfo(host: CaptureHost, raw: string): HostInfo {
  const info: HostInfo = { host };

  const lines = raw.split("\n", METADATA_SCAN_LINES);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const obj = parsed as Record<string, unknown>;

    if (host === "claude-code") {
      // Claude Code stamps these on every conversational record.
      info.hostVersion ??= firstString(obj.version);
      info.entrypoint ??= firstString(obj.entrypoint);
    } else {
      // Codex carries them on the leading `session_meta` payload.
      const payload =
        typeof obj.payload === "object" && obj.payload !== null
          ? (obj.payload as Record<string, unknown>)
          : undefined;
      info.hostVersion ??=
        firstString(payload?.cli_version) ?? firstString(obj.cli_version);
      info.entrypoint ??= firstString(payload?.originator);
    }

    if (info.hostVersion && info.entrypoint) break;
  }

  return info;
}

/**
 * The GenAI provider behind a host.
 *
 * Used for `gen_ai.provider.name`. This is the model vendor, not the tool
 * vendor — it is what makes plugin spans aggregate alongside the rest of a
 * tenant's GenAI telemetry instead of forming their own island.
 */
export function providerForHost(host: CaptureHost): string {
  return host === "claude-code" ? "anthropic" : "openai";
}
