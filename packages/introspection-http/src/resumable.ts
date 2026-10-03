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

/** Resume with content cursors; only a settling event confirms completion.
 * Replay gaps remain visible to consumers, and text() rejects incomplete output.
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
  /** Wall-clock deadline (ms) after which no further recovery is attempted. Default `300000` (5 min). */
  timeoutMs?: number;
  /**
   * Emit an opt-in AG-UI `CUSTOM` event (`name: "introspection.reconnect"`)
   * into the stream on each reconnect / readiness wait, so consumers can show a
   * "reconnecting…" affordance or record telemetry. Default `false` — the
   * stream is otherwise fully transparent. The marker rides the same `CUSTOM`
   * channel the DP uses for `resume_gap`, so it is expressible identically
   * in every language Introspection supports.
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
  const path = `/v1/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/stream`;
  const maxReconnects = opts.maxReconnects ?? 5;
  const baseMs = opts.backoffMs ?? 500;
  const deadline = Date.now() + (opts.timeoutMs ?? 300000);
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
          path: path.slice(0, -7),
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
