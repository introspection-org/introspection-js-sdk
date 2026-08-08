import type {
  Connection,
  ConnectionCreateParams,
  Connector,
  ConnectorAuthorizeParams,
  ConnectorAuthorizeResponse,
  ConnectorCreateParams,
  ConnectorListParams,
  ConnectorRequestOptions,
  ConnectorUpdateParams,
  CursorParams,
  Paginated,
  Uuid,
} from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import { Paginator, cursorPaginate } from "../pagination.js";

function projectQuery(
  options: ConnectorRequestOptions,
): Record<string, unknown> | undefined {
  return options.project ? { project: options.project } : undefined;
}

/**
 * Connections nested under a connector
 * (`/v1/connectors/{connector_id}/connections`) — one authorized subject
 * each (a Slack workspace, a person, an app credential). Every method
 * takes the connector id as its first argument; there is no PATCH on
 * connections, and the platform never serializes access/refresh tokens.
 */
export class ConnectionsApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * List a connector's connections. `await` the result for the first
   * page, or `for await` it to stream every connection across pages
   * (fetched lazily; stop early to stop fetching).
   */
  list(connectorId: Uuid, params: CursorParams = {}): Paginator<Connection> {
    return cursorPaginate(
      (next) =>
        this.http.request<Paginated<Connection>>({
          method: "GET",
          path: `/v1/connectors/${encodeURIComponent(connectorId)}/connections`,
          query: { ...params, next } as Record<string, unknown>,
        }),
      params.next,
    );
  }

  /**
   * Register a connection from a token the caller already holds
   * (registered mode). For the consent flow use
   * {@link ConnectorsApi.authorize} instead — the callback creates the
   * connection server-side.
   */
  create(
    connectorId: Uuid,
    params: ConnectionCreateParams,
  ): Promise<Connection> {
    return this.http.request<Connection>({
      method: "POST",
      path: `/v1/connectors/${encodeURIComponent(connectorId)}/connections`,
      body: params,
    });
  }

  get(connectorId: Uuid, connectionId: Uuid): Promise<Connection> {
    return this.http.request<Connection>({
      method: "GET",
      path: `/v1/connectors/${encodeURIComponent(connectorId)}/connections/${encodeURIComponent(connectionId)}`,
    });
  }

  /**
   * Revoke a connection. Named `revoke` rather than `delete` because it
   * destroys the provider token behind it — the subject must re-consent
   * to connect again.
   */
  revoke(connectorId: Uuid, connectionId: Uuid): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/v1/connectors/${encodeURIComponent(connectorId)}/connections/${encodeURIComponent(connectionId)}`,
      expect: "empty",
    });
  }
}

/**
 * CRUD on `/v1/connectors` plus the consent-URL mint
 * (`POST /v1/oauth/connections/authorize`), with connections nested as
 * {@link ConnectionsApi} under `.connections`.
 *
 * Connector CRUD routes are project-scoped: pass `project` (a slug or id)
 * in the options bag unless the token is already project-scoped.
 * `client_secret` / `signing_secret` are write-only — accepted on create
 * and update, absent from every read.
 *
 * The whole family sits behind a server-side feature flag; when it is off
 * every route returns a 404 whose detail reads "Connectors are not
 * enabled" (as opposed to a plain not-found for a missing connector).
 */
export class ConnectorsApi {
  readonly connections: ConnectionsApi;

  constructor(private readonly http: HttpClient) {
    this.connections = new ConnectionsApi(http);
  }

  /**
   * List connectors matching `params`. `await` the result for the first
   * page, or `for await` it to stream every connector across pages
   * (fetched lazily — `limit` sets the page size, `next` the starting
   * cursor; stop early to stop fetching).
   */
  list(params: ConnectorListParams = {}): Paginator<Connector> {
    return cursorPaginate(
      (next) =>
        this.http.request<Paginated<Connector>>({
          method: "GET",
          path: "/v1/connectors",
          query: { ...params, next } as Record<string, unknown>,
        }),
      params.next,
    );
  }

  /** Create a connector. Idempotent on `slug` — a repeat POST returns the live row. */
  create(
    params: ConnectorCreateParams,
    options: ConnectorRequestOptions = {},
  ): Promise<Connector> {
    return this.http.request<Connector>({
      method: "POST",
      path: "/v1/connectors",
      query: projectQuery(options),
      body: params,
    });
  }

  get(
    connectorId: Uuid,
    options: ConnectorRequestOptions = {},
  ): Promise<Connector> {
    return this.http.request<Connector>({
      method: "GET",
      path: `/v1/connectors/${encodeURIComponent(connectorId)}`,
      query: projectQuery(options),
    });
  }

  update(
    connectorId: Uuid,
    params: ConnectorUpdateParams,
    options: ConnectorRequestOptions = {},
  ): Promise<Connector> {
    return this.http.request<Connector>({
      method: "PATCH",
      path: `/v1/connectors/${encodeURIComponent(connectorId)}`,
      query: projectQuery(options),
      body: params,
    });
  }

  /** Soft-delete a connector; the server revokes its connections. */
  delete(
    connectorId: Uuid,
    options: ConnectorRequestOptions = {},
  ): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/v1/connectors/${encodeURIComponent(connectorId)}`,
      query: projectQuery(options),
      expect: "empty",
    });
  }

  /**
   * Mint a consent URL for a connector — the link a Business hands its
   * customer to connect (e.g. install the Slack app into a workspace).
   *
   * The URL embeds a single-use `state`, so it must not be cached: two
   * calls give two different URLs, and each is spent on first use. Raise
   * `expires_in` when handing the link to someone else to open later. A
   * chat-provider connector (`connector.requires_runtime === true`) 422s
   * unless `runtime` names the agent that replies.
   */
  authorize(
    connectorId: Uuid,
    params: ConnectorAuthorizeParams = {},
  ): Promise<ConnectorAuthorizeResponse> {
    return this.http.request<ConnectorAuthorizeResponse>({
      method: "POST",
      path: "/v1/oauth/connections/authorize",
      body: { connector_id: connectorId, ...params },
    });
  }
}

export function attachConnectors(http: HttpClient): ConnectorsApi {
  return new ConnectorsApi(http);
}
