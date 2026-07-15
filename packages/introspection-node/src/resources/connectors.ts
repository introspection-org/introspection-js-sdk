import type {
  Connector,
  ConnectorCreate,
  ConnectorListParams,
  ConnectorUpdate,
  Paginated,
  Uuid,
} from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import { Paginator, cursorPaginate } from "../pagination.js";

/**
 * Programmatic CRUD for `/v1/connectors` on the CP.
 *
 * A connector is the org-side *definition* of an outbound provider
 * (endpoints, credentials, scopes, approval policy). Agents reference it by
 * slug and mint tokens against it via `client.connections` /
 * `runner.connections`.
 */
export class ConnectorsApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * List connectors matching `params`. `await` for the first page, or
   * `for await` to stream every connector across pages.
   */
  list(params: ConnectorListParams = {}): Paginator<Connector> {
    return cursorPaginate(
      (next) =>
        this.http.request<Paginated<Connector>>({
          method: "GET",
          path: "/v1/connectors",
          query: { ...params, next } as unknown as Record<string, unknown>,
        }),
      params.next,
    );
  }

  get(id: Uuid): Promise<Connector> {
    return this.http.request<Connector>({
      method: "GET",
      path: `/v1/connectors/${encodeURIComponent(id)}`,
    });
  }

  create(input: ConnectorCreate): Promise<Connector> {
    return this.http.request<Connector>({
      method: "POST",
      path: "/v1/connectors",
      body: input,
    });
  }

  update(id: Uuid, input: ConnectorUpdate): Promise<Connector> {
    return this.http.request<Connector>({
      method: "PATCH",
      path: `/v1/connectors/${encodeURIComponent(id)}`,
      body: input,
    });
  }

  delete(id: Uuid): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/v1/connectors/${encodeURIComponent(id)}`,
      expect: "empty",
    });
  }
}

export function attachConnectors(http: HttpClient): ConnectorsApi {
  return new ConnectorsApi(http);
}
