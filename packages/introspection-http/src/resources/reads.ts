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
import type { Table } from "apache-arrow";
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
 * Load the optional `apache-arrow` peer dependency on demand — the JSON
 * path never needs it, so it is imported only when `format: "arrow"` or
 * the columnar `.arrow()` accessor is used.
 */
async function loadArrow(): Promise<typeof import("apache-arrow")> {
  try {
    return await import("apache-arrow");
  } catch (err) {
    throw new Error(
      "format: 'arrow' requires the optional 'apache-arrow' peer dependency. " +
        "Install it with `npm install apache-arrow`.",
      { cause: err },
    );
  }
}

/**
 * Deep-convert one decoded Arrow cell value to the plain JSON shape the
 * JSON transport returns. Arrow's `Row.toJSON()` is shallow: nested
 * `struct` columns (e.g. the typed event `payload`), maps, and list
 * columns come back as `StructRow` / `MapRow` / `Vector` proxies rather
 * than plain objects/arrays. Recursing through each container's own
 * `toJSON()` flattens them so JSON and Arrow rows are interchangeable.
 */
function arrowValueToPlain(value: unknown): unknown {
  // Arrow int64/uint64 cells decode to `bigint`, but the JSON transport
  // parses the same values to plain numbers. Convert when exact so JSON
  // and Arrow rows are interchangeable; values outside the safe-integer
  // range stay `bigint` rather than silently losing precision.
  if (
    typeof value === "bigint" &&
    value >= BigInt(Number.MIN_SAFE_INTEGER) &&
    value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date || value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(arrowValueToPlain);
  const withToJSON = value as { toJSON?: () => unknown };
  const json =
    typeof withToJSON.toJSON === "function" ? withToJSON.toJSON() : value;
  if (json !== value) return arrowValueToPlain(json);
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = arrowValueToPlain(entry);
  }
  return out;
}

const EVENT_PAYLOAD_JSON_FIELDS = new Set(["metadata", "params", "properties"]);

const EVENT_PAYLOAD_DATETIME_FIELDS = new Set([
  "created_at",
  "updated_at",
  "retired_at",
  "last_detected_at",
]);

/**
 * Restore the JSON representation promised by the row-oriented events API.
 *
 * The server's typed Arrow schema uses native timestamp columns and encodes
 * open dict-shaped payload fields as JSON strings. apache-arrow exposes the
 * former as epoch-millisecond numbers and leaves the latter as strings, so a
 * plain structural conversion is not enough to make `format: "arrow"` match
 * the JSON transport.
 */
function normalizeEventArrowRow(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const row = value as Record<string, unknown>;
  const timestamp = row.timestamp;
  if (timestamp instanceof Date) {
    row.timestamp = timestamp.toISOString();
  } else if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    row.timestamp = new Date(timestamp).toISOString();
  }

  const payload = row.payload;
  if (
    payload === null ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  ) {
    return row;
  }

  const payloadRecord = payload as Record<string, unknown>;
  for (const field of EVENT_PAYLOAD_DATETIME_FIELDS) {
    const fieldValue = payloadRecord[field];
    if (fieldValue instanceof Date) {
      payloadRecord[field] = fieldValue.toISOString();
    } else if (typeof fieldValue === "number" && Number.isFinite(fieldValue)) {
      payloadRecord[field] = new Date(fieldValue).toISOString();
    }
  }
  for (const field of EVENT_PAYLOAD_JSON_FIELDS) {
    const fieldValue = payloadRecord[field];
    if (typeof fieldValue !== "string") continue;
    try {
      payloadRecord[field] = JSON.parse(fieldValue) as unknown;
    } catch {
      // Preserve malformed values. The JSON transport is boundary-tolerant,
      // and turning a single bad optional field into a page-level failure
      // would make the Arrow path less robust than JSON.
    }
  }
  return row;
}

/** Read the pagination metadata headers off an Arrow response. */
function paginationFromHeaders(
  headers: Headers,
  recordCount: number,
): { count: number; total_count: number | null; next: string | null } {
  const next = headers.get("x-next-cursor");
  const count = headers.get("x-result-count");
  const totalCount = headers.get("x-total-count");
  return {
    count: count !== null ? Number(count) : recordCount,
    total_count: totalCount !== null ? Number(totalCount) : null,
    next: next ?? null,
  };
}

/**
 * Fetch one page as an Apache Arrow IPC stream and rebuild the
 * {@link Paginated} envelope the JSON path returns.
 *
 * The row values live in the columnar body — envelope fields as native
 * typed columns plus (for events) a typed `payload` struct column, which
 * is deep-converted back to plain nested objects so decoded rows match
 * the JSON shape. The pagination metadata moves to response headers
 * (`X-Next-Cursor`, `X-Result-Count`, `X-Truncated`, `X-Total-Count`).
 * Reading them back into {@link Paginated} keeps the paginator
 * format-agnostic. A `406` from a server that can't produce Arrow
 * surfaces as the usual typed HTTP error.
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
  let records: T[] = [];
  if (bytes.byteLength > 0) {
    const arrow = await loadArrow();
    records = arrow
      .tableFromIPC(bytes)
      .toArray()
      .map((row) => {
        const plain = arrowValueToPlain(row.toJSON());
        return (
          path === "/v1/events" ? normalizeEventArrowRow(plain) : plain
        ) as T;
      });
  }
  return { records, ...paginationFromHeaders(res.headers, records.length) };
}

/**
 * Columnar accessor over a Data-Plane telemetry list read: an async
 * iterable of one Apache Arrow `Table` per page, walking the same
 * `X-Next-Cursor` pagination as the row-oriented paths. Use
 * {@link readAll} to fetch and concatenate every page into a single
 * `Table` (zero pages yield an empty one).
 */
export class ArrowPages implements AsyncIterable<Table> {
  constructor(
    private readonly fetchPage: (
      next: string | undefined,
    ) => Promise<{ table: Table; next: string | undefined }>,
    private readonly start?: string,
  ) {}

  async *[Symbol.asyncIterator](): AsyncIterator<Table> {
    let cursor = this.start;
    do {
      const { table, next } = await this.fetchPage(cursor);
      yield table;
      cursor = next;
    } while (cursor !== undefined);
  }

  /** Fetch every page and concatenate into one `Table`. */
  async readAll(): Promise<Table> {
    const arrow = await loadArrow();
    const tables: Table[] = [];
    for await (const table of this) tables.push(table);
    const [first, ...rest] = tables;
    if (first === undefined) return new arrow.Table();
    return first.concat(...rest);
  }
}

/**
 * Build an {@link ArrowPages} columnar read over a telemetry list route.
 * Accepts the same ergonomic params as {@link listRead} (minus `format`,
 * which is implied); validation and `lookback` pinning behave
 * identically.
 */
export function arrowRead(
  http: ResourceHttpClient,
  path: string,
  params?: ListReadParams,
): ArrowPages {
  const source = params as Record<string, unknown> | undefined;
  const signal = params?.signal;
  const baseQuery = serializeReadParams(source, undefined);
  return new ArrowPages(async (next) => {
    const query = next !== undefined ? { ...baseQuery, next } : baseQuery;
    const res = await http.stream({
      path,
      query,
      headers: { Accept: ARROW_STREAM_MEDIA_TYPE },
      signal,
    });
    const arrow = await loadArrow();
    const bytes = new Uint8Array(await res.arrayBuffer());
    const table =
      bytes.byteLength > 0 ? arrow.tableFromIPC(bytes) : new arrow.Table();
    return { table, next: res.headers.get("x-next-cursor") ?? undefined };
  }, params?.next);
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
