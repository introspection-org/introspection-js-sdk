/**
 * Per-session capture checkpoint.
 *
 * Host transcripts are append-only JSONL, so "what have I already exported?"
 * collapses to a single byte offset. Each run normalizes only the bytes past the
 * checkpoint and advances it — which is what makes capture incremental instead
 * of re-reading and re-deduplicating a transcript that grows all session.
 *
 * Two properties this file exists to guarantee:
 *
 * - **Advance only after a successful flush.** The offset is written after spans
 *   are confirmed exported, never before. A crash, a network failure, or an
 *   expired token therefore costs a re-send of one turn on the next hook rather
 *   than a silently dropped one. Duplicate spans are recoverable; missing ones
 *   are not.
 * - **Never write inside the host's own directory.** State lives under
 *   `~/.introspection/`, not beside the transcript in `~/.claude/projects` or
 *   `~/.codex/sessions`. Those directories belong to the host, and a stray file
 *   in them is exactly the kind of thing that breaks a host's own session
 *   enumeration after an unrelated upgrade.
 */
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

import type { CaptureHost } from "./config.js";

/** Current on-disk schema version for a checkpoint file. */
export const CAPTURE_STATE_VERSION = 1;

/** What has already been exported for one session. */
export interface CaptureState {
  version: number;
  /** Bytes of the transcript already normalized and exported. */
  byteOffset: number;
  /** How many turns have been exported, used to order turns within a session. */
  turn: number;
  /** Last successful export (ISO-8601). */
  updatedAt?: string;
}

const INITIAL: CaptureState = {
  version: CAPTURE_STATE_VERSION,
  byteOffset: 0,
  turn: 0,
};

/**
 * Checkpoint path for a session.
 *
 * Keyed by host and session id. The session id is not interpolated raw — a
 * transcript-supplied identifier reaching a filesystem path is a traversal
 * waiting to happen, so anything outside a conservative character set is
 * replaced before it becomes a filename.
 */
export function captureStatePath(
  host: CaptureHost,
  sessionId: string,
  home: string = homedir(),
): string {
  const safe =
    sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "unknown";
  return join(home, ".introspection", "capture-state", host, `${safe}.json`);
}

/**
 * Read a session's checkpoint, or a zero checkpoint when there is none.
 *
 * A missing or unreadable checkpoint resolves to offset 0. That errs toward
 * re-sending a session rather than skipping one, consistent with the
 * advance-only-after-flush rule above.
 */
export async function readCaptureState(path: string): Promise<CaptureState> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    if (typeof raw !== "object" || raw === null) return INITIAL;
    const obj = raw as Record<string, unknown>;
    if (obj.version !== CAPTURE_STATE_VERSION) return INITIAL;
    return {
      version: CAPTURE_STATE_VERSION,
      byteOffset:
        typeof obj.byteOffset === "number" && obj.byteOffset >= 0
          ? obj.byteOffset
          : 0,
      turn: typeof obj.turn === "number" && obj.turn >= 0 ? obj.turn : 0,
      updatedAt: typeof obj.updatedAt === "string" ? obj.updatedAt : undefined,
    };
  } catch {
    return INITIAL;
  }
}

/**
 * Persist a checkpoint.
 *
 * Written to a temporary file and renamed, so a process killed mid-write leaves
 * either the old checkpoint or the new one — never a truncated file that would
 * read back as offset 0 and re-export the whole session.
 *
 * Returns whether the write succeeded. A failure is worth *reporting* (the next
 * run will duplicate a turn) but never worth throwing: the spans are already
 * delivered, and the user is waiting on their hook.
 */
export async function writeCaptureState(
  path: string,
  state: CaptureState,
): Promise<boolean> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(
      tmp,
      JSON.stringify({ ...state, version: CAPTURE_STATE_VERSION }),
      { encoding: "utf8", mode: 0o600 },
    );
    await rename(tmp, path);
    return true;
  } catch {
    return false;
  }
}
