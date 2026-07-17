import type { EventListParams, RawEvent } from "@introspection-sdk/types";
import type { Paginator } from "../pagination.js";
import { listRead } from "./reads.js";
import type { ResourceHttpClient } from "./types.js";

/**
 * Read-only Events API (`GET /v1/events`) — the raw event read surface
 * over `otel_logs`, plus the `introspection.observation` /
 * `introspection.pattern` projections selected via `grain`.
 *
 * `list()` walks the standard Introspection cursor envelope's opaque
 * `next` token, mirroring {@link ConversationsClient.list}. It accepts the
 * ergonomic ordering/window params (`order`, `start`, `end`, `lookback`)
 * and an optional `format: "arrow"` that negotiates an Apache Arrow IPC
 * stream while exposing the identical page shape.
 */
export class EventsClient {
  constructor(private readonly http: ResourceHttpClient) {}

  /**
   * List events matching `params`. `await` the result for the first page
   * (a {@link Paginated} envelope), or `for await` it to stream every
   * event across pages (fetched lazily — `limit` sets the page size,
   * `next` the starting cursor; stop early to stop fetching).
   *
   * Pass `lookback: "24h"` for a relative window, or `start`/`end` for an
   * explicit one — the two are mutually exclusive and combining them
   * throws a `ValidationError` before any request is sent.
   */
  list(params?: EventListParams): Paginator<RawEvent> {
    return listRead<RawEvent>(this.http, "/v1/events", params);
  }
}

export { EventsClient as EventsApi };
