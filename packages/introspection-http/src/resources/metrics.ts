import type {
  MetricQueryRequest,
  MetricQueryResponse,
} from "@introspection-sdk/types";
import type { ResourceHttpClient } from "./types.js";

/**
 * Metrics API (`POST /v1/metrics`) — the bounded, allow-listed telemetry
 * aggregation contract (view + metrics + dimensions + filters + time
 * dimension + explicit window + row/series limits).
 *
 * Unlike the Conversations / Events list reads this is a single POST that
 * returns a row-oriented `{ data, meta }` result rather than a
 * cursor-paginated envelope: aggregation, faceting, bucketing, and
 * percentiles all go through this one route. The request carries its own
 * explicit window (`from_timestamp` / `to_timestamp`), so it does not use
 * the ergonomic `lookback`/`start`/`end` params of the list reads. See
 * cloud `docs/design/metrics-api.md`.
 */
export class MetricsClient {
  constructor(private readonly http: ResourceHttpClient) {}

  /**
   * Run a metrics query. The request is validated server-side against the
   * bounded contract (unknown fields are rejected); a malformed query
   * surfaces as a `ValidationError`.
   */
  query(
    request: MetricQueryRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<MetricQueryResponse> {
    return this.http.request<MetricQueryResponse>({
      method: "POST",
      path: "/v1/metrics",
      body: request,
      signal: opts?.signal,
    });
  }
}

export { MetricsClient as MetricsApi };
