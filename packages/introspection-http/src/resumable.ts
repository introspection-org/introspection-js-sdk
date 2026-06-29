import {
  EventType,
  type AGUIEvent,
  type ConversationItem,
  type ConversationItemList,
  type Task,
  type TaskStatus,
} from "@introspection-sdk/types";
import { parseAgUiEvents } from "./agui-stream.js";
import type { ResourceHttpClient } from "./resources/types.js";

/**
 * Graceful turn resume (see `docs/design/sdk-resumable-streams.md`, INT-252).
 *
 * A turn is consumed over a long-lived SSE stream that can be severed before
 * the turn settles (gateway idle-timeout, LB recycle, network blip). The
 * runtime does **no replay on reconnect by design** — recovery is transcript
 * hydration. On a mid-turn drop this transparently catches the missed output
 * up from the durable transcript (`GET /v1/conversations/{id}/items`) and
 * re-attaches the live stream, delivering a single gap-free, duplicate-free
 * sequence to the caller, bounded by `maxResumes` and an overall deadline so
 * it never reconnects forever.
 *
 * Resume is a **pure client** concern: no server replay buffer, no new API
 * surface, and dedup is by the transcript item's stable `id` only (never by
 * the live frame's ephemeral, connection-local id).
 */

/** Task statuses that mean this turn settled successfully. */
const SETTLED_OK: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  // `idle` = this turn settled but the task is still alive (multi-turn);
  // for a single turn's resume loop that is settled-success.
  "idle",
  "completed",
]);

/** Task statuses that mean this turn settled as a failure. */
const SETTLED_FAILED: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  "failed",
  "cancelled",
]);

export interface StreamTurnOptions {
  /**
   * Opt into graceful resume. When `false` (the default) the turn is streamed
   * once with no transcript catch-up or reconnect, so existing callers are
   * unaffected.
   */
  resume?: boolean;
  /**
   * Conversation id backing the durable transcript. Defaults to `taskId` —
   * correct for tasks created without an explicit conversation identity (the
   * common SDK case).
   */
  conversationId?: string;
  /** Maximum reconnect+catch-up cycles before giving up. Default `3`. */
  maxResumes?: number;
  /** Ingest-lag grace window (ms) each catch-up polls across. Default `5000`. */
  graceWindowMs?: number;
  /** Backoff (ms) between empty catch-up polls. Default `500`. */
  pollMs?: number;
  /** Transcript page size for catch-up. Default `200`. */
  pageLimit?: number;
  /** Overall turn deadline (ms). Default `300000` (5 min). */
  timeoutMs?: number;
  /**
   * Bookmark seed — the newest transcript item id seen before this turn, so
   * the first catch-up only pulls this turn's items. `null`/omitted starts
   * from the conversation head.
   */
  afterId?: string;
  /** Abort the whole resume loop (and the in-flight stream/requests). */
  signal?: AbortSignal;
}

/**
 * One element of the resumable turn sequence: a live AG-UI `stream` event, a
 * durable `transcript` catch-up item, or a terminal `settled` / `exhausted`
 * marker. Live events and transcript items are distinct representations — the
 * live frame id is ephemeral and does not correlate to a transcript id — so
 * dedup applies to `transcript` items only (by stable `id`, across catch-ups).
 */
export type ResumableTurnEvent =
  | { type: "stream"; event: AGUIEvent }
  | { type: "transcript"; item: ConversationItem }
  | { type: "settled"; ok: boolean; status: TaskStatus | "completed" }
  | { type: "exhausted" };

interface StreamOutcome {
  /** The stream reached a clean EOF (HTTP 200, DP closed it = turn done). */
  closedCleanly: boolean;
  /** A `RUN_ERROR` AG-UI frame was observed. */
  sawRunError: boolean;
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

/**
 * Consume one `/stream` attachment to EOF, yielding AG-UI events. Records
 * whether the stream closed cleanly (turn complete) or was severed (an
 * exception while connecting or reading) into `outcome`.
 */
async function* consumeStream(
  http: ResourceHttpClient,
  taskId: string,
  runId: string,
  signal: AbortSignal | undefined,
  outcome: StreamOutcome,
): AsyncIterable<AGUIEvent> {
  try {
    const res = await http.stream({
      // Keep `wait_for_start` until the server advertises the 429-retry
      // contract (spec §6 phased migration) — do not drop it pre-emptively.
      path: `/v1/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/stream`,
      query: { wait_for_start: true },
      signal,
    });
    for await (const ev of parseAgUiEvents(res)) {
      if (ev.type === EventType.RUN_ERROR) outcome.sawRunError = true;
      yield ev;
    }
    // Reader reached `done` without throwing: the DP closed the stream on
    // turn completion. A clean close with no error frame = the turn completed.
    outcome.closedCleanly = true;
  } catch {
    // Severed before completion (network blip, idle-timeout, abort).
    outcome.closedCleanly = false;
  }
}

/**
 * Durable catch-up across the telemetry ingest grace window. Pages the
 * transcript forward from `state.bookmark` (`order=asc&after=`), yielding each
 * not-yet-seen item, then waits out late-landing items until a full grace
 * window passes with nothing new. Dedup is by stable item `id`; `state` is
 * mutated so the dedup set + bookmark carry across successive catch-ups within
 * one turn.
 */
async function* hydrateGap(
  http: ResourceHttpClient,
  conversationId: string,
  state: { bookmark: string | null; seen: Set<string> },
  opts: { graceWindowMs: number; pollMs: number; pageLimit: number },
  signal?: AbortSignal,
): AsyncIterable<ConversationItem> {
  const deadline = Date.now() + opts.graceWindowMs;
  for (;;) {
    let gained = 0;
    // Page forward over what has landed so far.
    for (;;) {
      const page = await http.request<ConversationItemList>({
        method: "GET",
        path: `/v1/conversations/${encodeURIComponent(conversationId)}/items`,
        query: {
          order: "asc",
          limit: opts.pageLimit,
          // Omit `after` only when the bookmark is null (first catch-up from
          // the conversation head).
          after: state.bookmark ?? undefined,
        },
        signal,
      });
      const items = page.data ?? [];
      for (const item of items) {
        if (!item?.id || state.seen.has(item.id)) continue;
        state.seen.add(item.id);
        state.bookmark = item.id;
        gained += 1;
        yield item;
      }
      if (!page.has_more) break;
    }
    if (gained === 0 && Date.now() >= deadline) break;
    if (gained === 0)
      await sleep(opts.pollMs, signal); // wait out the ingest grace window
    else if (Date.now() >= deadline) break;
  }
}

/** Cheap task status read — `GET /v1/tasks/{id}`, never `?include=agent`. */
async function getTaskStatus(
  http: ResourceHttpClient,
  taskId: string,
  signal?: AbortSignal,
): Promise<TaskStatus | null> {
  try {
    const task = await http.request<Task>({
      method: "GET",
      path: `/v1/tasks/${encodeURIComponent(taskId)}`,
      signal,
    });
    return task.status;
  } catch {
    return null;
  }
}

/**
 * Resumable turn consumer — see {@link ResumableTurnEvent} and the module
 * docstring. Yields live AG-UI events and durable transcript catch-up items as
 * a single sequence, ending with a terminal `settled` (turn finished) or
 * `exhausted` (`maxResumes`/deadline hit — surfaced, never an infinite loop)
 * event.
 */
export async function* streamTurnResumable(
  http: ResourceHttpClient,
  taskId: string,
  runId: string,
  opts: StreamTurnOptions = {},
): AsyncIterable<ResumableTurnEvent> {
  const conversationId = opts.conversationId ?? taskId;
  const maxResumes = opts.maxResumes ?? 3;
  const hydrateOpts = {
    graceWindowMs: opts.graceWindowMs ?? 5000,
    pollMs: opts.pollMs ?? 500,
    pageLimit: opts.pageLimit ?? 200,
  };
  const deadlineMs = opts.timeoutMs ?? 300000;
  const start = Date.now();
  const state = {
    bookmark: opts.afterId ?? null,
    seen: new Set<string>(),
  };

  // Pure passthrough when resume is opt-out: stream once, no catch-up, no
  // status reads — existing callers are unaffected.
  if (!opts.resume) {
    const outcome: StreamOutcome = { closedCleanly: false, sawRunError: false };
    for await (const ev of consumeStream(
      http,
      taskId,
      runId,
      opts.signal,
      outcome,
    )) {
      yield { type: "stream", event: ev };
    }
    yield {
      type: "settled",
      ok: outcome.closedCleanly && !outcome.sawRunError,
      status: "completed",
    };
    return;
  }

  let attempts = 0;
  while (
    attempts <= maxResumes &&
    Date.now() - start < deadlineMs &&
    !opts.signal?.aborted
  ) {
    const outcome: StreamOutcome = { closedCleanly: false, sawRunError: false };
    for await (const ev of consumeStream(
      http,
      taskId,
      runId,
      opts.signal,
      outcome,
    )) {
      yield { type: "stream", event: ev };
    }
    attempts += 1;

    if (outcome.closedCleanly) {
      // Clean close = turn complete; one final catch-up closes the ingest-lag
      // tail.
      for await (const item of hydrateGap(
        http,
        conversationId,
        state,
        hydrateOpts,
        opts.signal,
      )) {
        yield { type: "transcript", item };
      }
      yield {
        type: "settled",
        ok: !outcome.sawRunError,
        status: "completed",
      };
      return;
    }

    // Stream severed before completion — did the turn actually finish? The
    // cheap status read decides; catch up the durable gap either way.
    const status = await getTaskStatus(http, taskId, opts.signal);
    for await (const item of hydrateGap(
      http,
      conversationId,
      state,
      hydrateOpts,
      opts.signal,
    )) {
      yield { type: "transcript", item };
    }

    if (status && SETTLED_OK.has(status)) {
      yield { type: "settled", ok: true, status };
      return;
    }
    if (status && SETTLED_FAILED.has(status)) {
      yield { type: "settled", ok: false, status };
      return;
    }
    // pending|queued|scheduled|running|awaiting_user|cancelling → still live;
    // loop to re-open /stream for the rest of the turn.
  }

  // Exhausted maxResumes / deadline — surface it, do not loop forever.
  yield { type: "exhausted" };
}
