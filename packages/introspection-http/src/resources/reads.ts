/**
 * Shared plumbing for the bounded Data-Plane telemetry list reads
 * (`GET /v1/conversations`, `GET /v1/events`).
 *
 * These reads share one wire contract: cursor pagination over the
 * {@link Paginated} envelope, an ergonomic ordering/window param surface
 * the client serializes to query args, and an optional Apache Arrow IPC
 * response encoding negotiated via the `Accept` header. This module owns
 * the three pieces that differ from a plain resource `list()`:
 *
 *   1. {@link serializeReadParams} — maps `order`/`start`/`end`/`lookback`
 *      onto the wire (`direction`/`start_date`/`end_date`) and enforces the
 *      `lookback` ↔ `start`/`end` mutual exclusion client-side.
 *   2. {@link fetchArrowPage} — decodes an Arrow IPC stream back into the
 *      same {@link Paginated} shape the JSON path returns, reading the
 *      pagination metadata from response headers.
 *   3. {@link listRead} — wires either transport into a {@link Paginator}
 *      so `await`/`for await` and cursor exhaustion behave identically.
 */

import { ValidationError, type Paginated } from "@introspection-sdk/types";
import { tableFromIPC } from "apache-arrow";
import { Paginator, cursorPaginate } from "../pagination.js";
import type { ResourceHttpClient } from "./types.js";

/**
 * The IPC *streaming* media type (schema message + record batches + EOS),
 * matching the DP `Accept` negotiation. Not the random-access IPC *file*
 * format (`application/vnd.apache.arrow.file`).
 */
export const ARROW_STREAM_MEDIA_TYPE = "application/vnd.apache.arrow.stream";

/** Ergonomic + control keys consumed by the client, never sent on the wire. */
const CLIENT_ONLY_KEYS = new Set([
  "order",
  "start",
  "end",
  "lookback",
  "format",
  "signal",
  "next",
]);

const LOOKBACK_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

// `ms` must precede `m` in the alternation so `"500ms"` isn't read as `"500m"`.
const LOOKBACK_RE = /^(\d+)(ms|s|m|h|d|w)$/;

/** Convert a relative duration like `"24h"` / `"7d"` / `"500ms"` to milliseconds. */
function lookbackToMs(lookback: string): number {
  const match = LOOKBACK_RE.exec(lookback.trim());
  const amount = match?.[1];
  const unit = match?.[2];
  const unitMs = unit === undefined ? undefined : LOOKBACK_UNIT_MS[unit];
  if (amount === undefined || unitMs === undefined) {
    throw new ValidationError({
      message: `Invalid \`lookback\` "${lookback}" — expected a relative duration like "24h", "7d", or "500ms" (units: ms, s, m, h, d, w)`,
      status: 422,
      code: "invalid_request",
    });
  }
  return Number(amount) * unitMs;
}

/**
 * Serialize an ergonomic read-params object to the wire query args.
 *
 * Maps `order` → `direction`, `start` → `start_date`, `end` → `end_date`,
 * and `lookback` → a computed `start_date = now - lookback`. Every other
 * key (resource filters, `sort`, `limit`, …) passes through untouched.
 * `next` is supplied by the paginator and always wins over any `next` on
 * the params object.
 *
 * Throws a {@link ValidationError} — before any request is sent — when
 * `lookback` is combined with an explicit window (`start`/`end` or the
 * wire-native `start_date`/`end_date`).
 */
export function serializeReadParams(
  params: Record<string, unknown> | undefined,
  next: string | undefined,
): Record<string, unknown> {
  const src = params ?? {};
  const order = src.order as "asc" | "desc" | undefined;
  const start = src.start as string | undefined;
  const end = src.end as string | undefined;
  const lookback = src.lookback as string | undefined;

  const hasExplicitWindow =
    start !== undefined ||
    end !== undefined ||
    src.start_date !== undefined ||
    src.end_date !== undefined;
  if (lookback !== undefined && hasExplicitWindow) {
    throw new ValidationError({
      message:
        "`lookback` is mutually exclusive with `start`/`end` — pass a relative lookback or an explicit window, not both",
      status: 422,
      code: "invalid_request",
    });
  }

  const query: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(src)) {
    if (CLIENT_ONLY_KEYS.has(key)) continue;
    query[key] = value;
  }

  if (order !== undefined) query.direction = order;
  if (start !== undefined) query.start_date = start;
  if (end !== undefined) query.end_date = end;
  if (lookback !== undefined) {
    query.start_date = new Date(
      Date.now() - lookbackToMs(lookback),
    ).toISOString();
  }
  if (next !== undefined) query.next = next;
  return query;
}

/**
 * Fetch one page as an Apache Arrow IPC stream and rebuild the
 * {@link Paginated} envelope the JSON path returns.
 *
 * The row values live in the columnar body; the pagination metadata moves
 * to response headers (`X-Next-Cursor`, `X-Result-Count`, `X-Truncated`,
 * `X-Total-Count`). Reading them back into {@link Paginated} keeps the
 * paginator format-agnostic. A `406` from a server that can't produce
 * Arrow surfaces as the usual typed HTTP error.
 */
export async function fetchArrowPage<T>(
  http: ResourceHttpClient,
  path: string,
  query: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Paginated<T>> {
  const res = await http.stream({
    path,
    query,
    headers: { Accept: ARROW_STREAM_MEDIA_TYPE },
    signal,
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const records =
    bytes.byteLength === 0
      ? []
      : tableFromIPC(bytes)
          .toArray()
          .map((row) => row.toJSON() as T);

  const next = res.headers.get("x-next-cursor");
  const count = res.headers.get("x-result-count");
  const totalCount = res.headers.get("x-total-count");
  return {
    records,
    count: count !== null ? Number(count) : records.length,
    total_count: totalCount !== null ? Number(totalCount) : null,
    next: next ?? null,
  };
}

/**
 * The control fields {@link listRead} reads off a params object. The
 * resource-specific param interfaces (`ConversationListParams`,
 * `EventListParams`) each structurally satisfy this — they carry `next`
 * (via `ListParams`) and `format` (via `ReadWindowParams`) — so they pass
 * without an index signature.
 */
export interface ListReadParams {
  next?: string;
  format?: "json" | "arrow";
  signal?: AbortSignal;
}

/**
 * Build a {@link Paginator} over a Data-Plane telemetry list read.
 *
 * Both transports resolve to the same {@link Paginated} envelope, so
 * `await` (first page), `for await` (auto-paging to exhaustion via the
 * opaque `next` cursor), and early-stop behave identically whether the
 * caller asked for JSON (default) or `format: "arrow"`.
 */
export function listRead<T>(
  http: ResourceHttpClient,
  path: string,
  params?: ListReadParams,
): Paginator<T> {
  const source = params as Record<string, unknown> | undefined;
  const useArrow = params?.format === "arrow";
  const signal = params?.signal;
  // Serialize + validate once, eagerly: a `lookback`/`start`/`end` conflict
  // throws synchronously at the `list()` call (before any request), and the
  // relative `lookback` window is pinned to a single `now` so it can't drift
  // between pages as the cursor is walked. Only `next` varies per page.
  const baseQuery = serializeReadParams(source, undefined);
  return cursorPaginate<T>((next) => {
    const query = next !== undefined ? { ...baseQuery, next } : baseQuery;
    if (useArrow) {
      return fetchArrowPage<T>(http, path, query, signal);
    }
    return http.request<Paginated<T>>({
      method: "GET",
      path,
      query,
      signal,
    });
  }, params?.next);
}
