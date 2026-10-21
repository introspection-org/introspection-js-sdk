export type Uuid = string;
export type IsoDate = string;

/**
 * Environment lane a credential, application, or session belongs to.
 *
 * Assigned server-side — an access token carries it as an `environment` claim,
 * which the DP reads when it establishes a browser session. A client never
 * chooses its own lane.
 */
export type Environment = "development" | "staging" | "production";

export interface Paginated<T> {
  records: T[];
  count: number;
  total_count: number | null;
  next: string | null;
}

export interface ListParams {
  limit?: number;
  next?: string;
  include_total?: boolean;
}

/**
 * Cursor paging without `include_total`, for the routes that do not compute
 * one. Counting the full match set is not free on the append-only telemetry
 * stores, so `/v1/shares` and `/v1/events` deliberately do not offer it —
 * inheriting the flag there would type a filter that silently does nothing.
 */
export interface CursorParams {
  limit?: number;
  next?: string;
}

/**
 * Response representation for the bounded telemetry list reads
 * (`GET /v1/conversations`, `GET /v1/events`). `"json"` (the default)
 * returns the {@link Paginated} envelope; `"arrow"` negotiates an Apache
 * Arrow IPC stream via the `Accept` header and reconstructs the same
 * {@link Paginated} shape from the response body + pagination headers, so
 * paging is identical across formats.
 */
export type ReadFormat = "json" | "arrow";

/**
 * Ergonomic ordering + time-window params shared by the Data-Plane list
 * reads. The client serializes these to the wire query args before
 * sending: `order` → `direction`, `start` → `start_date`, `end` →
 * `end_date`, and `lookback` (a relative duration like `"24h"`) →
 * `start_date = now - lookback`.
 *
 * `lookback` is mutually exclusive with `start`/`end`; passing both
 * throws a {@link ValidationError} client-side before any request.
 */
export interface ReadWindowParams {
  /** Sort direction (server default `"desc"`). Maps to `direction`. */
  order?: "asc" | "desc";
  /**
   * Start of the (inclusive) time window as an ISO-8601 datetime. Maps to
   * `start_date`. Mutually exclusive with {@link lookback}.
   */
  start?: IsoDate;
  /**
   * End of the (inclusive) time window as an ISO-8601 datetime. Maps to
   * `end_date`. Mutually exclusive with {@link lookback}.
   */
  end?: IsoDate;
  /**
   * Relative window as a duration string — `"<n><unit>"` where unit is one
   * of `ms`, `s`, `m`, `h`, `d`, `w` (e.g. `"24h"`, `"7d"`, `"500ms"`).
   * Computed client-side into `start_date = now - lookback`. Mutually
   * exclusive with {@link start} / {@link end}.
   */
  lookback?: string;
  /** Response encoding: `"json"` (default) or `"arrow"`. */
  format?: ReadFormat;
}
