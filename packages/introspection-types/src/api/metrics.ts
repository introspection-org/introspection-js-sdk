import type { IsoDate } from "./common.js";

/** Aggregation views selectable in a `POST /v1/metrics` request. */
export type MetricView =
  | "spans"
  | "conversations"
  | "events"
  | "judgements"
  | "observations"
  | "patterns";

/** Aggregation operators. */
export type MetricAggregation =
  | "count"
  | "count_distinct"
  | "sum"
  | "avg"
  | "min"
  | "max"
  | "p50"
  | "p75"
  | "p90"
  | "p95"
  | "p99";

/** Filter operators for a metrics query. */
export type MetricFilterOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "nin"
  | "exists"
  | "contains";

/** Named time-bucket widths. */
export type MetricInterval =
  | "10s"
  | "30s"
  | "1m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "2h"
  | "3h"
  | "6h"
  | "12h"
  | "1d"
  | "2d"
  | "1w"
  | "1mo";

/** One requested metric: an aggregation over an optional measure field. */
export interface MetricSpec {
  /** Measure field. Omit for `count`; required for every other aggregation. */
  measure?: string | null;
  aggregation: MetricAggregation;
}

/** A group-by dimension. */
export interface MetricDimension {
  field: string;
}

/** A pre-aggregation row filter. */
export interface MetricFilter {
  field: string;
  operator: MetricFilterOperator;
  /** Scalar for comparison ops, list for `in`/`nin`, omitted for `exists`. */
  value?: string | number | boolean | Array<string | number | boolean> | null;
}

/** Time bucketing — supply `granularity` (named/`auto`) or `bins` (count). */
export interface MetricTimeDimension {
  granularity?: MetricInterval | "auto" | null;
  bins?: number | null;
}

/** Ordering term: reference a metric by index, a dimension by field, or time. */
export interface MetricOrderBy {
  type: "metric" | "dimension" | "time";
  direction?: "asc" | "desc";
  metric_index?: number | null;
  field?: string | null;
}

/** Post-aggregation filter on a metric by request index. */
export interface MetricHaving {
  metric_index: number;
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
  value: number;
}

/** Row/series limits for a metrics query. */
export interface MetricQueryConfig {
  row_limit?: number;
  series_limit?: number | null;
}

/**
 * Request body for `POST /v1/metrics` — the bounded, allow-listed
 * telemetry aggregation contract. Unknown fields are rejected server-side.
 */
export interface MetricQueryRequest {
  view: MetricView;
  metrics: MetricSpec[];
  dimensions?: MetricDimension[];
  filters?: MetricFilter[];
  time_dimension?: MetricTimeDimension | null;
  order_by?: MetricOrderBy[];
  having?: MetricHaving[];
  /** Window start (inclusive), ISO-8601 datetime. */
  from_timestamp: IsoDate;
  /** Window end (exclusive), ISO-8601 datetime. */
  to_timestamp: IsoDate;
  config?: MetricQueryConfig;
}

/** One resolved dimension field/value on a metrics result row. */
export interface MetricDimensionValue {
  field: string;
  value: string;
}

/** One resolved metric value on a metrics result row. */
export interface MetricResultValue {
  metric_index: number;
  measure: string | null;
  aggregation: MetricAggregation;
  value: number;
}

/** A single aggregated row of a metrics result. */
export interface MetricResultRow {
  /** Bucket start (epoch ms) when the query is time-bucketed, else `null`. */
  timestamp?: number | null;
  dimensions: MetricDimensionValue[];
  metrics: MetricResultValue[];
}

/** The time window actually applied to a metrics query. */
export interface MetricEffectiveWindow {
  start: IsoDate;
  end: IsoDate;
}

/** Metadata describing an executed metrics query. */
export interface MetricQueryMeta {
  view: MetricView;
  window: MetricEffectiveWindow;
  row_count: number;
  row_limit: number;
  interval?: MetricInterval | null;
  step_seconds?: number | null;
  /** True when a percentile aggregation used approximate state. */
  approximate: boolean;
  /** True when the result hit the row/series limit. */
  truncated: boolean;
  order_by: MetricOrderBy[];
}

/** Response body for `POST /v1/metrics`. */
export interface MetricQueryResponse {
  data: MetricResultRow[];
  meta: MetricQueryMeta;
}
