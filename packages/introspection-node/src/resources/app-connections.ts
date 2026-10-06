import type {
  AppConnection,
  AppConnectionCreateParams,
  AppConnectionListParams,
  ConnectPage,
  Paginated,
  Uuid,
} from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import { Paginator, cursorPaginate } from "../pagination.js";

/**
 * CRUD on `/v1/connections` (Data Plane): the apps members connected for
 * themselves. A caller who is not an administrator sees and manages only
 * their own. Reads need `connections:read`, `create` needs
 * `connections:write`, `delete` needs `connections:delete`.
 *
 * Connections under a connector are a different resource, on the Control
 * Plane's `client.connectors.connections`.
 *
 * `TCreate` narrows `create`'s params the way `TasksApi` narrows its own:
 * the client requires `runtime`, while a runner fills in its runtime group.
 */
export class AppConnectionsApi<
  TCreate extends AppConnectionCreateParams = AppConnectionCreateParams,
> {
  constructor(
    private readonly http: HttpClient,
    private readonly defaultRuntime: () => string | null | undefined = () =>
      undefined,
  ) {}

  /**
   * List connections. `await` the result for the first page, or `for await`
   * it to stream every connection across pages. Filters ride every page.
   */
  list(params: AppConnectionListParams = {}): Paginator<AppConnection> {
    const { next: start, ...filters } = params;
    return cursorPaginate(
      (next) =>
        this.http.request<Paginated<AppConnection>>({
          method: "GET",
          path: "/v1/connections",
          query: { ...filters, next } as Record<string, unknown>,
        }),
      start,
    );
  }

  /**
   * Mint a single-use connect page for one app. Send the member to
   * `authorize_url`; the connection exists once they finish there.
   */
  async create(params: TCreate): Promise<ConnectPage> {
    const runtime = params.runtime ?? this.defaultRuntime();
    if (!runtime) {
      throw new Error(
        "connections.create() needs the runtime whose sessions use the " +
          "connection: pass `runtime`, or call it on a runner whose context " +
          "carries a runtime_group_id.",
      );
    }
    return this.http.request<ConnectPage>({
      method: "POST",
      path: "/v1/connections",
      body: { app: params.app, runtime },
    });
  }

  /** Read one connection. */
  get(connectionId: Uuid): Promise<AppConnection> {
    return this.http.request<AppConnection>({
      method: "GET",
      path: `/v1/connections/${encodeURIComponent(connectionId)}`,
    });
  }

  /** Remove a connection. */
  delete(connectionId: Uuid): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/v1/connections/${encodeURIComponent(connectionId)}`,
      expect: "empty",
    });
  }
}
