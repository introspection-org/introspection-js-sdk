import type {
  Event,
  EventForName,
  EventListParams,
  IntrospectionEventName,
  UnknownEvent,
} from "@introspection-sdk/types";
import type { Paginator } from "../pagination.js";
import { ArrowPages, arrowRead, listRead } from "./reads.js";
import type { ResourceHttpClient } from "./types.js";

/**
 * Params accepted by {@link EventsClient.listArrow} — the columnar accessor
 * always negotiates Arrow, so the row-oriented `format` switch is
 * omitted.
 */
export type EventArrowParams = Omit<EventListParams, "format">;

/**
 * Read-only Events API (`GET /v1/events`) — the typed, discriminated
 * read surface over the six canonical platform event families
 * ({@link IntrospectionEventName}). Every request names exactly one
 * family via the REQUIRED `event_name` param, so every page is
 * homogeneous: rows are `Event` union members with the common envelope
 * and a nested, family-typed `payload`.
 *
 * `list()` walks the standard Introspection cursor envelope's opaque
 * `next` token, mirroring {@link ConversationsClient.list}. It accepts
 * the ergonomic ordering/window params (`order`, `start`, `end`,
 * `lookback`) and an optional `format: "arrow"` that negotiates an
 * Apache Arrow IPC stream while exposing the identical page shape. For
 * columnar consumption use {@link listArrow} instead, which yields
 * apache-arrow `Table`s directly.
 */
export class EventsClient {
  constructor(private readonly http: ResourceHttpClient) {}

  /**
   * List events of one family. `event_name` is required — the response
   * rows are typed to that family (`introspection.feedback` →
   * `FeedbackEvent`, …), and an `event_name` this SDK version doesn't
   * know falls back to `UnknownEvent` rather than failing, so a newer
   * server family degrades gracefully.
   *
   * `await` the result for the first page (a {@link Paginated}
   * envelope), or `for await` it to stream every event across pages
   * (fetched lazily — `limit` sets the page size, `next` the starting
   * cursor; stop early to stop fetching).
   *
   * Pass `lookback: "24h"` for a relative window, or `start`/`end` for
   * an explicit one — the two are mutually exclusive and combining them
   * throws a `ValidationError` before any request is sent. Family-scoped
   * filters (e.g. `pattern_id`, `include_superseded`, `status`) pass
   * through and are validated server-side against the requested family.
   */
  list<
    const N extends IntrospectionEventName | (string & Record<never, never>),
  >(params: EventListParams & { event_name: N }): Paginator<EventForName<N>> {
    return listRead<EventForName<N>>(this.http, "/v1/events", params);
  }

  /**
   * Read one event by id, across every family. Unlike {@link list}, no
   * `event_name` is supplied, so the caller cannot know the family in
   * advance: the result is the closed {@link Event} union widened with
   * {@link UnknownEvent}, because a family added server-side after this
   * SDK version is returned as-is rather than dropped. Narrow with
   * `isKnownEvent` (or on `event_name`) before touching `payload`.
   *
   * Throws `NotFoundError` when the id does not resolve within the
   * caller's tenant scope.
   */
  get(eventId: string): Promise<Event | UnknownEvent> {
    return this.http.request<Event | UnknownEvent>({
      method: "GET",
      path: `/v1/events/${encodeURIComponent(eventId)}`,
    });
  }

  /**
   * Columnar read: async-iterate one Apache Arrow `Table` per page, or
   * call `.readAll()` to fetch and concatenate every page into a single
   * `Table`. Pages carry the constant envelope columns plus a typed
   * `payload` struct column fixed by the requested `event_name`.
   *
   * Requires the optional `apache-arrow` peer dependency.
   */
  listArrow(params: EventArrowParams): ArrowPages {
    return arrowRead(this.http, "/v1/events", params);
  }
}

export { EventsClient as EventsApi };
