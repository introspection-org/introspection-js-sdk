import {
  EventType,
  RateLimitError,
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
 * hydration. On a mid-turn disconnect this transparently catches the missed
 * output up from the durable transcript (`GET /v1/conversations/{id}/items`)
 * and re-attaches the live stream, delivering a single gap-free,
 * duplicate-free sequence to the caller, bounded by `maxResumes` and an
 * overall deadline so it never reconnects forever.
 *
 * Readiness is the `429`-retry contract (design §6): the attach sends
 * `wait_for_start=0`, so the DP returns `429` + `Retry-After` + `{status}`
 * while the run is not yet attachable and `200` + SSE once it is. This honours
 * `Retry-After` as the floor of a capped-exponential backoff and retries the
 * attach — surfacing each wait as a {@link ResumableTurnEvent} `waiting` event
 * — without consuming a resume.
 *
 * Resume is a **pure client** concern: no server-side replay buffer, no new
 * API surface, dedup by the transcript item's stable `id` only.
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

/** Cap on the readiness-retry backoff (ms). */
const MAX_RETRY_BACKOFF_MS = 10000;

export interface StreamTurnOptions {
  /**
   * Opt into graceful resume. When `false` (the default) the turn is streamed
   * once with no transcript catch-up or reconnect after a mid-turn drop, so
   * existing callers are unaffected. The readiness `429` wait still applies.
   */
  resume?: boolean;
  /**
   * Send `wait_for_start=1` (legacy server long-poll) instead of `0`. Default
   * `false` (`wait_for_start=0`) — the DP returns `429`/`Retry-After` until the
   * run is attachable and the client backs off (design §6). Set `true` only
   * against a DP that has not yet shipped the `429` contract.
   */
  waitForStart?: boolean;
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
  /**
   * Base (ms) for the capped-exponential readiness-retry backoff on a `429`.
   * `Retry-After` is the floor; this is the starting step. Default `500`.
   */
  retryBackoffMs?: number;
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
 * durable `transcript` catch-up item, a `waiting` readiness notice (the DP is
 * not attachable yet — `429`), or a terminal `settled` / `exhausted` marker.
 * Live events and transcript items are distinct representations — the live
 * frame id is ephemeral and does not correlate to a transcript id — so dedup
 * applies to `transcript` items only (by stable `id`, across catch-ups).
 */
export type ResumableTurnEvent =
  | { type: "stream"; event: AGUIEvent }
  | { type: "transcript"; item: ConversationItem }
  | { type: "waiting"; status: string | null; retryAfterMs: number | null }
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
 * Readiness backoff: `Retry-After` (ms) as the floor of a capped-exponential
 * step (`base * 2^n`). `n` is the consecutive-429 count, reset on a successful
 * attach.
 */
function retryBackoff(
  n: number,
  retryAfterMs: number | null,
  baseMs: number,
): number {
  const exp = Math.min(baseMs * 2 ** n, MAX_RETRY_BACKOFF_MS);
  return Math.max(retryAfterMs ?? 0, exp);
}

/** The DP's readiness phase, if the `429` body carries a `status`. */
function phaseOf(body: unknown): string | null {
  if (body && typeof body === "object") {
    const s = (body as Record<string, unknown>).status;
    if (typeof s === "string") return s;
  }
  return null;
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
 * docstring. Yields live AG-UI events, durable transcript catch-up items, and
 * `waiting` readiness notices as a single sequence, ending with a terminal
 * `settled` (turn finished) or `exhausted` (`maxResumes`/deadline hit —
 * surfaced, never an infinite loop) event.
 */
export async function* streamTurnResumable(
  http: ResourceHttpClient,
  taskId: string,
  runId: string,
  opts: StreamTurnOptions = {},
): AsyncIterable<ResumableTurnEvent> {
  const conversationId = opts.conversationId ?? taskId;
  const maxResumes = opts.maxResumes ?? 3;
  const retryBackoffMs = opts.retryBackoffMs ?? 500;
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
  const streamPath = `/v1/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/stream`;
  // Default to `wait_for_start=0` so the DP advertises readiness via 429
  // rather than holding the connection open (design §6).
  const waitFlag = opts.waitForStart ? 1 : 0;

  let attempts = 0;
  let retry429 = 0;
  while (Date.now() - start < deadlineMs && !opts.signal?.aborted) {
    // --- attach: open /stream, honouring the 429 "not live yet" contract ---
    let res: Response | null = null;
    try {
      res = await http.stream({
        path: streamPath,
        query: { wait_for_start: waitFlag },
        signal: opts.signal,
      });
    } catch (err) {
      if (err instanceof RateLimitError) {
        const retryAfterMs =
          err.retryAfter != null ? err.retryAfter * 1000 : null;
        yield { type: "waiting", status: phaseOf(err.body), retryAfterMs };
        const remaining = deadlineMs - (Date.now() - start);
        if (remaining <= 0) break;
        const wait = retryBackoff(retry429++, retryAfterMs, retryBackoffMs);
        await sleep(Math.min(wait, remaining), opts.signal);
        continue; // retry the attach — a readiness wait, not a resume
      }
      // Connect failed before a 200 (network blip) — treat as a severed turn.
    }
    retry429 = 0; // got past the readiness wait

    // --- consume the attached stream to EOF ---
    const outcome: StreamOutcome = { closedCleanly: false, sawRunError: false };
    if (res) {
      try {
        for await (const ev of parseAgUiEvents(res)) {
          if (ev.type === EventType.RUN_ERROR) outcome.sawRunError = true;
          yield { type: "stream", event: ev };
        }
        // Clean EOF: the DP closed the stream on turn completion. A clean
        // close with no error frame = the turn completed.
        outcome.closedCleanly = true;
      } catch {
        outcome.closedCleanly = false; // severed mid-read
      }
    }
    attempts += 1;

    // Resume opt-out: stream once, no catch-up, no reconnect.
    if (!opts.resume) {
      yield {
        type: "settled",
        ok: outcome.closedCleanly && !outcome.sawRunError,
        status: "completed",
      };
      return;
    }

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
      yield { type: "settled", ok: !outcome.sawRunError, status: "completed" };
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
    // re-open /stream for the rest of the turn, bounded by maxResumes.
    if (attempts > maxResumes) break;
  }

  // Exhausted maxResumes / deadline — surface it, do not loop forever.
  yield { type: "exhausted" };
}
