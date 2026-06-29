import { EventSchemas, type AGUIEvent } from "@ag-ui/core";
import { RateLimitError } from "@introspection-sdk/types";
import { parseStreamFrames } from "./agui-stream.js";
import type { ResourceHttpClient } from "./resources/types.js";

/**
 * Transparent stream resume (see `docs/design/sdk-resumable-streams.md`,
 * INT-252).
 *
 * A turn is consumed over a long-lived SSE stream that can be severed before
 * the turn settles (gateway idle-timeout, load-balancer recycle, network
 * blip). Rather than surface that as a turn failure — losing every event
 * between the drop and a manual retry — the run stream reconnects
 * transparently: it tracks the last content-frame id and re-attaches with the
 * SSE-standard `Last-Event-ID` header, so the server replays the frames the
 * client missed and the iterator yields a single gap-free `AGUIEvent`
 * sequence. There is **no consumer-visible change**: the stream either
 * completes (the DP closed it on turn completion) or throws once recovery is
 * exhausted, exactly like a plain stream.
 *
 * Readiness folds in the same way: a not-yet-attachable run answers the attach
 * with `429` + `Retry-After`, which is honoured as a backoff floor and retried
 * — never surfaced to the caller.
 */

/** Cap on the reconnect/readiness backoff (ms). */
const MAX_BACKOFF_MS = 10000;

export interface StreamOptions {
  /**
   * Maximum consecutive reconnects with no forward progress before the stream
   * gives up and throws. Reset whenever a reconnect delivers a new event.
   * Default `5`.
   */
  maxReconnects?: number;
  /** Base (ms) for the capped-exponential reconnect/readiness backoff. Default `500`. */
  backoffMs?: number;
  /** Overall wall-clock deadline (ms) for the whole turn. Default `300000` (5 min). */
  timeoutMs?: number;
  /** Abort the stream (and any in-flight reconnect). */
  signal?: AbortSignal;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** `Retry-After` (ms) as the floor of a capped-exponential step (`base * 2^n`). */
function backoff(
  n: number,
  retryAfterMs: number | null,
  baseMs: number,
): number {
  const exp = Math.min(baseMs * 2 ** n, MAX_BACKOFF_MS);
  return Math.max(retryAfterMs ?? 0, exp);
}

/**
 * Consume a run's SSE stream as a single gap-free `AGUIEvent` sequence,
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
  let lastEventId: string | null = null;
  let reconnects = 0;

  for (;;) {
    if (opts.signal?.aborted) {
      throw opts.signal.reason ?? new DOMException("Aborted", "AbortError");
    }

    // --- attach (honouring the 429 readiness contract) ---
    let res: Response;
    try {
      res = await http.stream({
        path,
        headers:
          lastEventId !== null ? { "Last-Event-ID": lastEventId } : undefined,
        signal: opts.signal,
      });
    } catch (err) {
      const retryAfterMs =
        err instanceof RateLimitError && err.retryAfter != null
          ? err.retryAfter * 1000
          : null;
      // A 429 (not attachable yet) is a readiness wait, not a failed attempt;
      // any other connect error counts toward the no-progress reconnect budget.
      if (!(err instanceof RateLimitError)) reconnects += 1;
      if (reconnects > maxReconnects || Date.now() >= deadline) throw err;
      await sleep(
        Math.min(
          backoff(reconnects, retryAfterMs, baseMs),
          deadline - Date.now(),
        ),
        opts.signal,
      );
      continue;
    }

    // --- consume to EOF, tracking the resume cursor ---
    let progressed = false;
    try {
      for await (const frame of parseStreamFrames(res)) {
        if (frame.id && /^[0-9]+$/.test(frame.id)) lastEventId = frame.id;
        if (frame.name !== "ag_ui") continue; // ignore heartbeats etc.
        progressed = true;
        yield EventSchemas.parse(JSON.parse(frame.data) as unknown);
      }
      // Clean EOF: the DP closed the stream on turn completion.
      return;
    } catch (err) {
      // Severed mid-read. Forward progress (any new event) resets the budget so
      // a long turn with intermittent drops still recovers; a reconnect that
      // delivers nothing counts down.
      reconnects = progressed ? 0 : reconnects + 1;
      if (reconnects > maxReconnects || Date.now() >= deadline) throw err;
      await sleep(
        Math.min(backoff(reconnects, null, baseMs), deadline - Date.now()),
        opts.signal,
      );
    }
  }
}
