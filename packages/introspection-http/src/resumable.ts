import { EventSchemas, EventType, type AGUIEvent } from "@ag-ui/core";
import {
  IntrospectionAPIError,
  RateLimitError,
  RunFailedError,
  StreamIncompleteError,
  type TaskRun,
} from "@introspection-sdk/types";
import { backoffMs, sleep } from "./backoff.js";
import { parseStreamFrames } from "./agui-stream.js";
import type { ResourceHttpClient } from "./resources/types.js";

/**
 * Stream recovery for a run's SSE stream.
 *
 * The stream attaches from cursor `0`, so it includes output produced before
 * the first connection. Only a settling `RUN_FINISHED` or `RUN_ERROR` confirms
 * completion and ends it; a `RUN_FINISHED` with `result.reason =
 * "stream_close"` marks the end of one attach and is not forwarded. A severed
 * connection reconnects. A connection that closes cleanly without a settling
 * event first reads the run's status (`GET /v1/tasks/{task_id}/runs/{run_id}`):
 * `failed` or `cancelled` throws `RunFailedError`; `idle`, `completed` or
 * `awaiting_user` means the run settled without a complete stream and throws
 * `StreamIncompleteError`; anything else, including a failed status read,
 * reconnects.
 *
 * Every reconnect resumes from the last content cursor (`Last-Event-ID`). Only
 * a new content cursor renews {@link StreamOptions.timeoutMs} and resets
 * {@link StreamOptions.maxReconnects}; lifecycle events, heartbeats and
 * replayed content renew neither. The timeout is checked before each retry,
 * never during an open connection, so a long stream keeps recovering past its
 * original window as long as content advances. A `429` means the run is not
 * attachable yet: the stream waits (honouring `Retry-After`) within the timeout
 * without spending the reconnect budget.
 *
 * When the cursor is older than the server's replay buffer, the stream
 * continues with one AG-UI `MESSAGES_SNAPSHOT` holding the run's messages so
 * far; its id becomes the new cursor. When the server holds neither the frames
 * nor a snapshot it answers `410` and the stream throws
 * `StreamIncompleteError`. Runtime images that predate the snapshot send
 * `CUSTOM resume_gap` instead; raw streams pass it through.
 *
 * Use a concrete run id when consuming one turn: `runs/current` is a moving
 * alias, so a reconnect or status read may resolve to the next turn. The
 * in-process fake sandbox (`mock://`) replies through the conversation
 * transcript, not SSE, so its attach-only `stream_close` cannot satisfy
 * `RunHandle.text()`.
 *
 * The shared `run-stream-contract.json` fixtures pin this behaviour across the
 * Swift, JavaScript, Rust and Python SDKs; each suite pins the fixture SHA-256,
 * so an intentional contract change updates all four copies together.
 */

export interface StreamOptions {
  /**
   * Maximum consecutive reconnects with no forward progress before the stream
   * gives up and throws. Reset only when a new content cursor is delivered.
   * Does not bound `429` readiness waits — `timeoutMs` does. Default `5`.
   */
  maxReconnects?: number;
  /** Base (ms) for the capped-exponential reconnect/readiness backoff. Default `500`. */
  backoffMs?: number;
  /** Recovery window (ms), renewed by each new content cursor; checked before retrying. Default `300000` (5 min). */
  timeoutMs?: number;
  /**
   * Emit an opt-in AG-UI `CUSTOM` event (`name: "introspection.reconnect"`)
   * into the stream on each reconnect / readiness wait, so consumers can show a
   * "reconnecting…" affordance or record telemetry. Default `false` — the
   * stream is otherwise fully transparent. A `CUSTOM` event is expressible
   * identically in every language Introspection supports.
   */
  emitReconnectEvents?: boolean;
  /** Abort the stream (and any in-flight reconnect). */
  signal?: AbortSignal;
}

/** The readiness phase from a `429` body, when present. */
function phaseOf(body: unknown): string | null {
  if (body && typeof body === "object") {
    const s = (body as Record<string, unknown>).status;
    if (typeof s === "string") return s;
  }
  return null;
}

/**
 * Build the `introspection.reconnect` AG-UI `CUSTOM` event. Validated through
 * the AG-UI schema so it is a well-formed `AGUIEvent` the caller can switch on
 * (`ev.type === EventType.CUSTOM && ev.name === "introspection.reconnect"`).
 */
function reconnectEvent(value: Record<string, unknown>): AGUIEvent {
  return EventSchemas.parse({
    type: EventType.CUSTOM,
    name: "introspection.reconnect",
    value,
  } as unknown);
}

/**
 * Consume a run's SSE stream as a resumable `AGUIEvent` sequence,
 * reconnecting transparently on a mid-turn disconnect via `Last-Event-ID`.
 * See the module docstring. Yields only AG-UI events; transport frames
 * (heartbeats) and control-frame ids are handled internally.
 */
export async function* streamResumable(
  http: ResourceHttpClient,
  taskId: string,
  runId: string,
  opts: StreamOptions = {},
): AsyncIterable<AGUIEvent> {
  const runPath = `/v1/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}`;
  const path = `${runPath}/stream`;
  const maxReconnects = opts.maxReconnects ?? 5;
  const baseMs = opts.backoffMs ?? 500;
  const timeoutMs = opts.timeoutMs ?? 300000;
  let deadline = Date.now() + timeoutMs;
  // The last *content*-frame id, replayed via `Last-Event-ID` on reconnect.
  // Control frames (RUN_* lifecycle, heartbeats) carry a non-numeric `c-…` id
  // that is not a valid resume cursor, so only numeric ids advance it.
  let lastEventId = "0";
  let reconnects = 0;
  // Readiness waits are counted separately from reconnects: a 429 means the
  // run is not attachable yet, which is not a failed attempt. It still needs
  // its own counter, though -- feeding a pinned 0 to `backoffMs` left the
  // delay at a flat 0-500ms for the whole window, roughly 1200 attach
  // attempts against an endpoint that had just asked us to back off.
  let readinessWaits = 0;

  for (;;) {
    if (opts.signal?.aborted) {
      throw opts.signal.reason ?? new DOMException("Aborted", "AbortError");
    }

    // --- attach (honouring the 429 readiness contract) ---
    let res: Response;
    try {
      res = await http.stream({
        path,
        headers: { "Last-Event-ID": lastEventId },
        signal: opts.signal,
      });
    } catch (err) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? err;
      // 410: the runtime holds neither the frames after this cursor nor a
      // snapshot covering them, so no reconnect can complete the stream.
      if (err instanceof IntrospectionAPIError && err.status === 410)
        throw new StreamIncompleteError(
          "The stream history is no longer available; read the conversation transcript",
        );
      if (
        err instanceof IntrospectionAPIError &&
        err.status >= 400 &&
        err.status < 500 &&
        err.status !== 429 &&
        err.status !== 409
      )
        throw err;
      const isRateLimit = err instanceof RateLimitError;
      const retryAfterMs =
        isRateLimit && err.retryAfter != null ? err.retryAfter * 1000 : null;
      // A 429 (not attachable yet) is a readiness wait, not a failed attempt;
      // any other connect error counts toward the no-progress reconnect budget.
      if (isRateLimit) readinessWaits += 1;
      else reconnects += 1;
      if (reconnects > maxReconnects || Date.now() >= deadline) throw err;
      const attempt = isRateLimit ? readinessWaits : reconnects;
      if (opts.emitReconnectEvents) {
        yield reconnectEvent({
          reason: isRateLimit ? "readiness" : "connect_error",
          attempt,
          lastEventId,
          phase: isRateLimit ? phaseOf(err.body) : null,
          retryAfterMs,
        });
      }
      await sleep(
        Math.min(
          backoffMs(attempt, retryAfterMs, baseMs),
          deadline - Date.now(),
        ),
        opts.signal,
      );
      continue;
    }

    let progressed = false;
    let interruption: unknown;
    let decoding = false;
    try {
      for await (const frame of parseStreamFrames(res)) {
        if (frame.name !== "ag_ui") continue;
        decoding = true;
        const event = EventSchemas.parse(JSON.parse(frame.data) as unknown);
        decoding = false;
        const control =
          event.type === EventType.RUN_STARTED ||
          event.type === EventType.RUN_FINISHED ||
          event.type === EventType.RUN_ERROR;
        if (!control && frame.id && /^[0-9]+$/.test(frame.id)) {
          if (BigInt(frame.id) <= BigInt(lastEventId)) continue;
          lastEventId = frame.id;
          deadline = Date.now() + timeoutMs;
          progressed = true;
        }
        if (
          event.type === EventType.RUN_FINISHED &&
          event.result?.reason === "stream_close"
        )
          continue;
        yield event;
        if (
          event.type === EventType.RUN_FINISHED ||
          event.type === EventType.RUN_ERROR
        )
          return;
      }
    } catch (err) {
      if (decoding || opts.signal?.aborted) throw err;
      interruption = err;
    }
    if (opts.signal?.aborted)
      throw opts.signal.reason ?? new DOMException("Aborted", "AbortError");
    if (interruption === undefined) {
      let state: TaskRun | undefined;
      try {
        state = await http.request<TaskRun>({
          method: "GET",
          path: runPath,
          signal: opts.signal,
        });
      } catch (err) {
        if (opts.signal?.aborted) throw err;
      }
      if (state?.status === "failed" || state?.status === "cancelled") {
        throw new RunFailedError(`The run ended with status ${state.status}`);
      }
      if (
        state &&
        ["idle", "completed", "awaiting_user"].includes(state.status)
      ) {
        throw new StreamIncompleteError(
          "The run settled without a complete stream; read the conversation transcript",
        );
      }
    }
    reconnects = progressed ? 0 : reconnects + 1;
    if (reconnects > maxReconnects || Date.now() >= deadline) {
      throw (
        interruption ??
        new StreamIncompleteError("The stream ended before the run settled")
      );
    }
    if (opts.emitReconnectEvents) {
      yield reconnectEvent({
        reason: interruption === undefined ? "stream_close" : "severed",
        attempt: reconnects,
        lastEventId,
      });
    }
    await sleep(
      Math.min(backoffMs(reconnects, null, baseMs), deadline - Date.now()),
      opts.signal,
    );
  }
}
