// jscpd:ignore-start -- import list: the same names as every resource client's
import type {
  ConnectionTokenParams,
  ConnectionTokenResult,
  Connector,
  ConnectorApp,
  ConnectorAppListParams,
  ConnectorAuthorizeParams,
  ConnectorAuthorizeResponse,
  ConnectorCreateParams,
  ConnectorCustomAppSearchParams,
  ConnectorListParams,
  ConnectorOAuthDiscoveryResponse,
  ConnectorSecretResponse,
  ConnectorUpdateParams,
  ProjectRef,
  Uuid,
} from "@introspection-sdk/types";
// jscpd:ignore-end
import type { HttpClient } from "../http.js";
import { Paginator, paginateGet } from "../pagination.js";
import { projectQuery } from "./project-scoped.js";

/**
 * CRUD on `/v1/connectors` plus the consent-URL mint
 * (`POST /v1/oauth/connections/authorize`) and the connection token mint
 * (`POST /v1/oauth/connections/token`). The connections themselves are the
 * Data Plane's `client.connections`.
 *
 * Connector CRUD uses the project carried by the authenticated credential.
 * `client_secret` / `signing_secret` are write-only — accepted on create
 * and update, absent from every read.
 *
 */
export class ConnectorsApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * Resolve a connector credential for the authenticated subject. For a
   * `person_authorized` connector this may return `authorization_pending`
   * with the mission and approval URL instead of a token.
   */
  connectionToken(
    connectorId: Uuid,
    params: ConnectionTokenParams = {},
  ): Promise<ConnectionTokenResult> {
    return this.http.request<ConnectionTokenResult>({
      method: "POST",
      path: "/v1/oauth/connections/token",
      schema: "ConnectionTokenResult",
      body: { connector_id: connectorId, ...params },
    });
  }

  /**
   * List connectors matching `params`. `await` the result for the first
   * page, or `for await` it to stream every connector across pages
   * (fetched lazily — `limit` sets the page size, `next` the starting
   * cursor; stop early to stop fetching).
   */
  list(params: ConnectorListParams = {}): Paginator<Connector> {
    return paginateGet<Connector>(
      this.http,
      "/v1/connectors",
      params,
      params.next,
      "Paginated<Connector>",
    );
  }

  /**
   * Create a connector. Upserts on `slug`: a repeat POST replaces the live
   * row's configuration and keeps its provider, auth mode and stored secrets.
   * A new `webhook` connector's generated secret comes back once, as
   * `signing_secret`; a repeat create of its slug returns none.
   */
  create(params: ConnectorCreateParams): Promise<ConnectorSecretResponse> {
    return this.http.request<ConnectorSecretResponse>({
      method: "POST",
      path: "/v1/connectors",
      schema: "ConnectorSecretResponse",
      body: params,
    });
  }

  get(connectorId: Uuid): Promise<Connector> {
    return this.http.request<Connector>({
      method: "GET",
      path: `/v1/connectors/${encodeURIComponent(connectorId)}`,
      schema: "Connector",
    });
  }

  /**
   * Update a connector. With `rotate_signing_secret: true` a `webhook`
   * connector's new secret comes back once, as `signing_secret`.
   */
  update(
    connectorId: Uuid,
    params: ConnectorUpdateParams,
  ): Promise<ConnectorSecretResponse> {
    return this.http.request<ConnectorSecretResponse>({
      method: "PATCH",
      path: `/v1/connectors/${encodeURIComponent(connectorId)}`,
      schema: "ConnectorSecretResponse",
      body: params,
    });
  }

  /** Soft-delete a connector; the server revokes its connections. */
  /** `project` selects the project for a credential that names none. */
  delete(connectorId: Uuid, project?: ProjectRef): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/v1/connectors/${encodeURIComponent(connectorId)}`,
      query: projectQuery(project),
      expect: "empty",
    });
  }

  /**
   * Search the provider's application catalogue. Pipedream connectors use
   * the returned slug when minting an application-specific Connect Link.
   */
  async listApps(
    connectorId: Uuid,
    params: ConnectorAppListParams = {},
  ): Promise<ConnectorApp[]> {
    const response = await this.http.request<{ data: ConnectorApp[] }>({
      method: "GET",
      path: `/v1/connectors/${encodeURIComponent(connectorId)}/apps`,
      schema: "{ data: ConnectorApp[]; }",
      query: params as Record<string, unknown>,
    });
    return response.data;
  }

  /**
   * Search the open MCP registry — the catalogue a custom connector picks
   * from. Needs no connector: read it before creating one, then pass the
   * listing's `mcp_url` to {@link discoverOAuth} or `create({ issuer })`.
   */
  async searchCustomApps(
    params: ConnectorCustomAppSearchParams,
  ): Promise<ConnectorApp[]> {
    const response = await this.http.request<{ data: ConnectorApp[] }>({
      method: "GET",
      path: "/v1/connectors/custom/apps",
      schema: "{ data: ConnectorApp[]; }",
      query: params as unknown as Record<string, unknown>,
    });
    return response.data;
  }

  /**
   * Resolve a provider's OAuth metadata before creating a custom connector.
   * `issuer` may be the authorization server or the MCP server it protects.
   *
   * This may REGISTER an OAuth client with the provider (dynamic
   * registration) and return its `client_id` / `client_secret` — pass those
   * to {@link create} so a second client is not registered. (`create` with
   * only `issuer` also discovers and registers on its own.) Raises a
   * {@link ValidationError} (400) when discovery fails.
   */
  discoverOAuth(issuer: string): Promise<ConnectorOAuthDiscoveryResponse> {
    return this.http.request<ConnectorOAuthDiscoveryResponse>({
      method: "POST",
      path: "/v1/connectors/discover-oauth",
      schema: "ConnectorOAuthDiscoveryResponse",
      body: { issuer },
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
   *
   * Pipedream connectors additionally require `app`, selected from
   * {@link listApps}. `allow_progressive_scopes` is optional and defaults to
   * false, matching Pipedream's Connect API.
   *
   * `binding` (with `runtime`) writes the runtime's MCP endpoint in the same
   * transaction as the grant, so the runtime is never authorized-but-unbound.
   *
   * Passing `params.identity` mints a `customer` member for the asserted
   * end user, so it can raise a {@link ConflictError} (409) when the org has
   * reached its member limit — a plan conflict, not back-pressure.
   *
   * To install an organization integration (Google Workspace, Microsoft 365)
   * instead of a connector, pass `null` and `params.integration_id`.
   */
  authorize(
    connectorId: Uuid | null,
    params: ConnectorAuthorizeParams = {},
  ): Promise<ConnectorAuthorizeResponse> {
    return this.http.request<ConnectorAuthorizeResponse>({
      method: "POST",
      path: "/v1/oauth/connections/authorize",
      schema: "ConnectorAuthorizeResponse",
      body:
        connectorId === null
          ? params
          : { connector_id: connectorId, ...params },
    });
  }
}

export function attachConnectors(http: HttpClient): ConnectorsApi {
  return new ConnectorsApi(http);
}
