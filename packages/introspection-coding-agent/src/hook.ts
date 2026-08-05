/**
 * Hook entrypoint.
 *
 * Both hosts invoke a hook as a subprocess with a JSON event on stdin, and both
 * hand over the two things capture needs: a session identifier and a path to the
 * session transcript. The field names differ, so this module normalizes them and
 * leaves everything else to {@link capture}.
 *
 * The governing constraint is that **the user is waiting**. A hook sits in the
 * turn loop of an interactive coding session, so this path fails open in every
 * direction: unparseable input, an unknown event, a missing transcript, a dead
 * collector, and an outright crash all resolve to "do nothing, exit 0". Capture
 * that degrades a coding session is worse than no capture.
 */
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";

import { capture, type CaptureResult } from "./capture.js";
import {
  clearCaptureActivationRequest,
  materializeCaptureActivation,
} from "./activation.js";
import type { CaptureHost } from "./config.js";

/**
 * Hard ceiling on a single hook run.
 *
 * Past this the run is abandoned and the checkpoint is left untouched, so the
 * work simply lands on the next turn. A capped, occasionally-skipped capture is
 * a fair trade for never being the reason a turn feels slow.
 */
export const HOOK_DEADLINE_MS = 5_000;

/** The normalized shape of a host hook event. */
export interface HookEvent {
  host: CaptureHost;
  sessionId: string;
  transcriptPath: string;
  turnId?: string;
  hookEventName?: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Normalize a host hook payload.
 *
 * The host is inferred from the payload's own shape rather than trusted from a
 * flag: Claude Code sends `hook_event_name` with snake_case session fields,
 * Codex identifies a rollout. An explicit `--host` still wins when the caller
 * passes one, since a future host revision may blur these.
 */
export function parseHookEvent(
  payload: unknown,
  hostHint?: CaptureHost,
): HookEvent | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const obj = payload as Record<string, unknown>;

  const transcriptPath =
    str(obj.transcript_path) ??
    str(obj.rollout_path) ??
    str(obj.session_path) ??
    str(obj.path);
  if (!transcriptPath) return undefined;

  const sessionId =
    str(obj.session_id) ??
    str(obj.thread_id) ??
    str(obj.conversation_id) ??
    // Fall back to the transcript's filename stem, which both hosts derive from
    // the session id. Better than dropping the turn: a stable-but-derived id
    // still groups a session correctly.
    transcriptPath
      .split("/")
      .pop()
      ?.replace(/\.jsonl$/, "");
  if (!sessionId) return undefined;

  const host: CaptureHost =
    hostHint ??
    (transcriptPath.includes("/.codex/sessions/") ||
    transcriptPath.includes("\\.codex\\sessions\\")
      ? "codex"
      : "claude-code");

  const turnId = str(obj.turn_id);
  const hookEventName = str(obj.hook_event_name);
  return {
    host,
    sessionId,
    transcriptPath,
    ...(turnId ? { turnId } : {}),
    ...(hookEventName ? { hookEventName } : {}),
  };
}

/** Read all of stdin. Resolves to an empty string if stdin is closed or unreadable. */
export async function readStdin(
  stream: NodeJS.ReadableStream = process.stdin,
): Promise<string> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    return "";
  }
}

/**
 * Run capture for one hook event, bounded by {@link HOOK_DEADLINE_MS}.
 *
 * The deadline aborts logical capture so a late export cannot advance the
 * checkpoint. The standalone hook executable also terminates after this result,
 * which prevents an exporter socket from extending the host's hook latency.
 */
export async function runHook(
  input: string,
  hostHint?: CaptureHost,
  options: {
    dryRun?: boolean;
    deadlineMs?: number;
    home?: string;
    exporterOverride?: SpanExporter;
  } = {},
): Promise<CaptureResult> {
  let payload: unknown;
  try {
    payload = JSON.parse(input);
  } catch {
    return { outcome: "transcript-unreadable", detail: "stdin was not JSON" };
  }

  if (typeof payload === "object" && payload !== null) {
    const object = payload as Record<string, unknown>;
    if (str(object.hook_event_name) === "SessionStart") {
      const sessionId = str(object.session_id) ?? str(object.thread_id);
      if (hostHint && sessionId) {
        await clearCaptureActivationRequest(hostHint, sessionId, options.home);
        return { outcome: "no-new-records", bytesRead: 0 };
      }
      return {
        outcome: "transcript-unreadable",
        detail: "SessionStart payload named no host/session",
      };
    }
  }

  const event = parseHookEvent(payload, hostHint);
  if (!event) {
    return {
      outcome: "transcript-unreadable",
      detail: "hook payload named no transcript",
    };
  }

  const deadline = options.deadlineMs ?? HOOK_DEADLINE_MS;
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      (async () => {
        const activation = await materializeCaptureActivation({
          host: event.host,
          sessionId: event.sessionId,
          transcriptPath: event.transcriptPath,
          turnId: event.turnId,
          home: options.home,
        });
        if (
          activation.outcome === "no-consent" ||
          activation.outcome === "host-not-covered"
        ) {
          return {
            outcome: activation.outcome,
            detail: activation.detail ?? `activation ${activation.outcome}`,
          } as CaptureResult;
        }
        if (
          activation.outcome !== "activated" &&
          activation.outcome !== "request-missing"
        ) {
          return {
            outcome: "not-activated",
            detail: activation.detail ?? `activation ${activation.outcome}`,
          } as CaptureResult;
        }
        return capture({
          host: event.host,
          sessionId: event.sessionId,
          transcriptPath: event.transcriptPath,
          dryRun: options.dryRun,
          home: options.home,
          exporterOverride: options.exporterOverride,
          // Both supported hosts invoke this command only from turn-completion
          // hooks (Claude Stop/SessionEnd; Codex Stop/SessionEnd).
          finalizeTrailingTurn: true,
          signal: controller.signal,
        });
      })(),
      new Promise<CaptureResult>((resolve) => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({
            outcome: "export-failed",
            detail: `capture exceeded ${deadline}ms; deferred to next turn`,
          });
        }, deadline);
        // Do not hold the event loop open on behalf of the deadline itself.
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    return {
      outcome: "export-failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
