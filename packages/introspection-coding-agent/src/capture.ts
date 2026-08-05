/**
 * Capture orchestration: transcript bytes in, exported spans out.
 *
 * The whole path is incremental. Each run reads only the bytes appended since
 * the last checkpoint, normalizes that chunk as a *partial* transcript, turns it
 * into spans, exports them, and only then advances the checkpoint.
 *
 * Nothing here throws. Every outcome — including every failure — is a
 * {@link CaptureResult} with a reason, because the caller is a hook that must
 * exit 0 regardless. The reasons are enumerated rather than free-text so
 * `--dry-run` can explain a silent no-op, which is otherwise the single most
 * confusing thing about a telemetry integration.
 */
import { open, stat } from "node:fs/promises";
import { normalizeTranscript } from "@letta-ai/trajectory";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";

import {
  coversHost,
  resolveTelemetryConfig,
  type CaptureHost,
  type TelemetryConfig,
} from "./config.js";
import { loadLoginProfile, resolveTracesEndpoint } from "./credentials.js";
import { createTracing } from "./exporter.js";
import { readHostInfo } from "./host.js";
import { emitTurnSpans, resourceAttributes } from "./spans.js";
import {
  captureStatePath,
  readCaptureState,
  writeCaptureState,
} from "./state.js";
import { responseIdForTurn, segmentTranscript } from "./turns.js";

/** Why a capture run did nothing, or what it did. */
export type CaptureOutcome =
  | "exported"
  | "no-consent"
  | "host-not-covered"
  | "not-logged-in"
  | "no-new-records"
  | "transcript-unreadable"
  | "normalize-failed"
  | "export-failed";

/** The result of one capture run. */
export interface CaptureResult {
  outcome: CaptureOutcome;
  /** Spans created and exported, when the run got that far. */
  spanCount?: number;
  /** Bytes of transcript consumed this run. */
  bytesRead?: number;
  /** Human-readable detail for `--dry-run` and debug logging. Never a secret. */
  detail?: string;
}

/** Inputs for one capture run — what the host hands the hook. */
export interface CaptureRequest {
  host: CaptureHost;
  /** Host-stable session id. */
  sessionId: string;
  /** Absolute path to the session transcript. */
  transcriptPath: string;
  /** Skip export and report what *would* happen. */
  dryRun?: boolean;
  /** Injected for tests; production uses the OTLP exporter. */
  exporterOverride?: SpanExporter;
  /** Injected for tests. */
  home?: string;
  /** Pre-resolved consent, so a caller that already resolved it need not re-read. */
  config?: TelemetryConfig;
  /**
   * Whether the host hook establishes that the trailing native turn finished.
   * Production Stop/SessionEnd hooks do; tests and other callers can set false
   * while a transcript is still being appended.
   */
  finalizeTrailingTurn?: boolean;
}

/**
 * Read the transcript from `offset`, stopping at the last complete line.
 *
 * Two things make this less trivial than a `readFile`:
 *
 * - **Line alignment.** A transcript is appended to while we read it, so the
 *   tail is frequently a half-written record. We cut at the final newline and
 *   report the offset of that cut, so the next run resumes exactly on a record
 *   boundary and no record is ever parsed twice or in halves.
 * - **Byte offsets, not string offsets.** Transcripts contain non-ASCII content
 *   constantly (paths, prose, emoji). Tracking the checkpoint in string length
 *   would drift from the real file position on the first multi-byte character
 *   and corrupt every subsequent read.
 */
async function readNewLines(
  path: string,
  offset: number,
): Promise<
  { text: string; consumed: number; startByteOffset: number } | undefined
> {
  let handle;
  try {
    const info = await stat(path);
    // A transcript that shrank was replaced or rotated; the old checkpoint no
    // longer describes this file, so start over rather than read from a stale
    // offset into unrelated bytes.
    const start = info.size < offset ? 0 : offset;
    if (info.size <= start) {
      return { text: "", consumed: 0, startByteOffset: start };
    }

    handle = await open(path, "r");
    const length = info.size - start;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);

    const lastNewline = buffer.lastIndexOf(0x0a);
    if (lastNewline < 0) {
      return { text: "", consumed: 0, startByteOffset: start };
    }

    const complete = buffer.subarray(0, lastNewline + 1);
    return {
      text: complete.toString("utf8"),
      consumed: complete.length,
      startByteOffset: start,
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Run one capture.
 *
 * Ordering is deliberate: consent, then host coverage, then credentials, then
 * any filesystem work. The cheapest and most consequential gate runs first, so
 * a machine that never opted in does no transcript I/O at all.
 */
export async function capture(request: CaptureRequest): Promise<CaptureResult> {
  const config = request.config ?? (await resolveTelemetryConfig(request.home));
  if (!config.enabled) {
    return {
      outcome: "no-consent",
      detail: "telemetry capture is not enabled",
    };
  }
  if (!coversHost(config, request.host)) {
    return {
      outcome: "host-not-covered",
      detail: `consent does not cover ${request.host}`,
    };
  }

  const profile = await loadLoginProfile(request.home);
  if (!profile) {
    return {
      outcome: "not-logged-in",
      detail: "no unexpired Introspection login; run `introspection login`",
    };
  }

  const statePath = captureStatePath(
    request.host,
    request.sessionId,
    request.home,
  );
  const state = await readCaptureState(statePath);

  const chunk = await readNewLines(request.transcriptPath, state.byteOffset);
  if (!chunk) {
    return {
      outcome: "transcript-unreadable",
      detail: `could not read ${request.transcriptPath}`,
    };
  }
  if (chunk.consumed === 0) {
    return { outcome: "no-new-records", bytesRead: 0 };
  }

  const hostInfo = readHostInfo(request.host, chunk.text);

  let segmented;
  try {
    segmented = segmentTranscript(request.host, chunk.text, {
      finalizeTrailingTurn: request.finalizeTrailingTurn ?? true,
      claudeStandaloneSidechain: state.claudeStandaloneSidechain,
    });
  } catch (error) {
    return {
      outcome: "normalize-failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const completeTurns = segmented.turns.filter((turn) => turn.complete);
  if (completeTurns.length === 0) {
    return {
      outcome: "no-new-records",
      bytesRead: chunk.consumed,
      detail: "no complete native turns past the checkpoint",
    };
  }

  let normalizedTurns;
  try {
    normalizedTurns = completeTurns.map((turn) => ({
      turn,
      records: normalizeTranscript({
        source: request.host,
        transcript: turn.transcript,
        sourceContext: {
          groupId: request.sessionId,
          baseByteOffset: chunk.startByteOffset + turn.startByteOffset,
          // A native turn is a fragment of the conversation. Partial mode keeps
          // cross-boundary tool linkage valid without weakening our own boundary.
          partial: true,
        },
        filters: {
          toolResults: config.content === "full" ? "include" : "omit",
        },
      }).records,
    }));
  } catch (error) {
    return {
      outcome: "normalize-failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (request.dryRun) {
    return {
      outcome: "exported",
      spanCount: 0,
      bytesRead: chunk.consumed,
      detail: `dry run: ${normalizedTurns.length} turns / ${normalizedTurns.reduce((sum, item) => sum + item.records.length, 0)} records from ${request.host} ${hostInfo.hostVersion ?? "(unknown version)"}, content=${config.content}`,
    };
  }

  const tracing = createTracing(
    resolveTracesEndpoint(profile),
    profile.accessToken,
    resourceAttributes(hostInfo),
    request.exporterOverride,
  );

  let spanCount = 0;
  try {
    for (const [index, item] of normalizedTurns.entries()) {
      const emitted = emitTurnSpans(tracing.tracer, item.records, {
        sessionId: request.sessionId,
        hostInfo,
        content: config.content,
        turn: state.turn + index,
        responseId: responseIdForTurn(
          request.host,
          request.sessionId,
          item.turn.key,
        ),
        cwd: item.turn.metadata.cwd ?? segmented.metadata.cwd ?? state.cwd,
        gitBranch:
          item.turn.metadata.gitBranch ??
          segmented.metadata.gitBranch ??
          state.gitBranch,
      });
      spanCount += emitted.spanCount;
    }
    // `shutdown` flushes the SimpleSpanProcessor and drains the export.
    await tracing.provider.shutdown();
  } catch (error) {
    return {
      outcome: "export-failed",
      spanCount,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  // `shutdown()` resolving is NOT evidence of delivery. OTel routes export
  // errors to its global error handler and resolves anyway, so a dead collector
  // is indistinguishable from success at this point — which would advance the
  // checkpoint past a turn that never arrived and skip it permanently. The
  // tracked result code is the only real signal, so it gates the checkpoint.
  const failure = tracing.exportFailure();
  if (failure) {
    return { outcome: "export-failed", spanCount, detail: failure.message };
  }

  const lastTurn = completeTurns[completeTurns.length - 1]!;
  await writeCaptureState(statePath, {
    version: state.version,
    byteOffset: chunk.startByteOffset + lastTurn.endByteOffset,
    turn: state.turn + completeTurns.length,
    cwd: segmented.metadata.cwd ?? state.cwd,
    gitBranch: segmented.metadata.gitBranch ?? state.gitBranch,
    claudeStandaloneSidechain:
      segmented.claudeStandaloneSidechain ?? state.claudeStandaloneSidechain,
    updatedAt: new Date().toISOString(),
  });

  return { outcome: "exported", spanCount, bytesRead: chunk.consumed };
}
