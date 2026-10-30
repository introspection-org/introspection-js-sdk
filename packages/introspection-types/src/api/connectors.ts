import type { CursorParams, Environment, IsoDate, Uuid } from "./common.js";
import type { RunIdentityInput } from "./runner.js";

/**
 * How a connector authenticates against its provider.
 *
 * - `"static"`             — a caller-supplied long-lived token.
 * - `"oauth_stored"`       — OAuth tokens stored server-side after consent.
 * - `"client_credentials"` — server-to-server OAuth client credentials.
 * - `"identity_assertion"` — per-call signed identity assertions.
 * - `"federated_exchange"` — federated token exchange.
 * - `"person_authorized"`  — per-action human-in-the-loop approval.
 * - `"aauth"`              — AAuth: the platform is the connector's Agent
 *   Provider and its egress signs for the session; approvals come from
 *   `person_server_url`. Requires `person_server_url` and `application_id`.
 */
export type ConnectorAuthMode =
  | "static"
  | "oauth_stored"
  | "client_credentials"
  | "identity_assertion"
  | "federated_exchange"
  | "person_authorized"
  | "aauth";

export type ConnectorStatus = "pending" | "active" | "error";

export type ConnectionStatus =
  "pending_authorization" | "active" | "refresh_failed" | "revoked";

/** Who a connection acts as against the provider. */
export type ConnectionSubjectType =
  "app" | "user" | "federated" | "person" | "workspace";

/** Subjects currently accepted by registered connection creation. */
export type ConnectionCreateSubjectType = "app" | "user";

/** Subjects currently accepted by authorize and token-broker operations. */
export type ConnectionBrokerSubjectType = "app" | "user" | "person";

/** A Cedar entity reference, e.g. `{ type: "Company", id: "acme" }`. */
export interface EntityUid {
  type: string;
  id: string;
}

/**
 * A Cedar entity a recipe's policies read, in Cedar's JSON entity format:
 * e.g. a company and the seniority its business-class bookings need.
 *
 * ```ts
 * {
 *   uid: { type: "Company", id: "acme" },
 *   attrs: { business_min_level: 5 },
 *   parents: [],
 * }
 * ```
 */
export interface PolicyEntity {
  uid: EntityUid;
  attrs?: Record<string, unknown>;
  parents?: EntityUid[];
}

/**
 * A connector — a project-scoped integration to an external provider
 * (e.g. Slack, Gmail, Stripe) that connections are minted under.
 *
 * `client_secret` and `signing_secret` are write-only: accepted on create
 * and update, absent from every response — this read model deliberately
 * does not declare them.
 */
export interface Connector {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  created_at: IsoDate;
  updated_at: IsoDate;
  /** Stable per-project identifier; create upserts on it. */
  slug: string;
  name: string;
  /** Provider slug, e.g. `"slack"`, `"gmail"`, `"stripe"`. */
  provider: string;
  auth_mode: ConnectorAuthMode;
  /** Create-time fact — not updatable. */
  environment: Environment;
  agent_member_id?: Uuid | null;
  authorization_endpoint?: string | null;
  token_endpoint?: string | null;
  scopes: string[];
  api_hosts: string[];
  client_id?: string | null;
  person_server_url?: string | null;
  application_id?: Uuid | null;
  assertion_audience?: string | null;
  webhook_url?: string | null;
  status: ConnectorStatus;
  created_by_member_id?: Uuid | null;
  metadata?: Record<string, unknown> | null;
  /** Cedar entities for the recipe's policies; see {@link PolicyEntity}. */
  policy_entities?: PolicyEntity[] | null;
  /**
   * Server-derived: whether `authorize` must name a `runtime` for this
   * connector (chat providers need the agent that replies). Read this —
   * never hardcode a provider list.
   */
  requires_runtime: boolean;
}

export interface ConnectorCreateParams {
  name: string;
  /** Provider slug, e.g. `"slack"`, `"gmail"`, `"stripe"`. */
  provider: string;
  auth_mode: ConnectorAuthMode;
  /** Derived from `name` when omitted. */
  slug?: string;
  /** Lane the connector serves (default `"production"`). */
  environment?: Environment;
  agent_member_id?: Uuid;
  authorization_endpoint?: string;
  token_endpoint?: string;
  scopes?: string[];
  api_hosts?: string[];
  client_id?: string;
  /** Write-only — never present on any response. */
  client_secret?: string;
  /** Write-only — never present on any response. */
  signing_secret?: string;
  /**
   * Provider settings. A `pipedream` connector requires
   * `provider_workspace_id` (its Connect project id, `proj_...`).
   */
  metadata?: Record<string, unknown>;
  /**
   * OAuth discovery: when set and the endpoints are omitted, the server
   * resolves `authorization_endpoint` / `token_endpoint` from the issuer's
   * `.well-known` metadata. Not persisted.
   */
  issuer?: string;
  /** Where approvals come from; required for an `aauth` connector. */
  person_server_url?: string;
  /** Required for an `aauth` connector. */
  application_id?: Uuid;
  assertion_audience?: string;
  webhook_url?: string;
  /** Cedar entities for the recipe's policies; see {@link PolicyEntity}. */
  policy_entities?: PolicyEntity[];
}

/**
 * PATCH body — only these fields are mutable (`environment`, `provider`,
 * `auth_mode`, and `slug` are create-time facts). Only provided fields
 * change; leaving `client_secret` / `signing_secret` blank means
 * "unchanged", not "clear".
 */
export interface ConnectorUpdateParams {
  name?: string;
  agent_member_id?: Uuid;
  scopes?: string[];
  api_hosts?: string[];
  status?: ConnectorStatus;
  metadata?: Record<string, unknown>;
  webhook_url?: string;
  /** Write-only; omit to leave the stored secret unchanged. */
  client_secret?: string;
  /** Write-only; omit to leave the stored secret unchanged. */
  signing_secret?: string;
  /** Replaces the Cedar entities; see {@link PolicyEntity}. */
  policy_entities?: PolicyEntity[];
}

export interface ConnectorListParams extends CursorParams {
  /** The project, for a credential that names none (an org member's session). */
  project?: string;
}

export interface ConnectorApp {
  /** Provider-specific application slug accepted by `authorize({ app })`. */
  slug: string;
  name: string;
  icon_url?: string | null;
  description?: string | null;
  auth_type?: string | null;
  /** The listing's MCP server URL, where it has one. */
  mcp_url?: string | null;
  /** The vendor's documentation for this server, where the registry knows it. */
  docs_url?: string | null;
}

export interface ConnectorAppListParams {
  /** Provider catalogue search text. */
  q?: string;
  /** Maximum applications returned (1–50, server default 20). */
  limit?: number;
}

/** Search of the open MCP registry — the catalogue a custom connector picks from. */
export interface ConnectorCustomAppSearchParams {
  /** Search text (2–100 characters). */
  q: string;
  /** Maximum applications returned (1–50, server default 20). */
  limit?: number;
}

/** How the platform identified itself to a custom OAuth provider. */
export type ConnectorClientRegistration =
  "client_id_metadata_document" | "dynamic";

/**
 * What OAuth discovery learned about a provider's authorization server,
 * plus the client identity it registered (if any).
 */
export interface ConnectorOAuthDiscoveryResponse {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string | null;
  token_endpoint_auth_methods_supported: string[];
  code_challenge_methods_supported: string[];
  scopes_supported: string[];
  client_id_metadata_document_supported: boolean;
  /**
   * RFC 9728 resource identifier when discovery started at an MCP server;
   * sent as the RFC 8707 `resource` parameter.
   */
  resource?: string | null;
  /** The callback this deployment sends; register it exactly on a hand-made client. */
  redirect_uri: string;
  /** Set when discovery registered (or identified) a client — pass it to `create`. */
  client_id?: string | null;
  /** Set when dynamic registration issued one — pass it to `create`. Never logged. */
  client_secret?: string | null;
  /** How `client_id` was obtained; unset when the provider offers no automatic registration. */
  client_registration?: ConnectorClientRegistration | null;
}

/**
 * The MCP endpoint binding a connect completes into. On a successful grant
 * the control plane writes the endpoint in the same transaction as the
 * connection, so the runtime is never authorized-but-unbound. Requires
 * `runtime` alongside it on `authorize`.
 */
export interface ConnectorAuthorizeBinding {
  /** Runtime environment the endpoint serves. */
  environment: Environment;
  /** The Recipe MCP server id this connector backs (`package.json#pi.mcp.servers[].id`). */
  mcp_server_id: string;
  /** Streamable-HTTP MCP resource URL (https). */
  url: string;
  /** Display label; defaults to `mcp_server_id`. */
  name?: string;
  /** Extra non-Authorization headers injected alongside the connection token. */
  headers?: Record<string, string>;
}

export interface ConnectorAuthorizeParams {
  /**
   * Provider application slug to connect. Required for Pipedream connectors;
   * discover valid values with `connectors.listApps()`.
   */
  app?: string;
  /**
   * Let the user grant a supported subset of the application's configured
   * OAuth scopes. Pipedream defaults this to `false`.
   */
  allow_progressive_scopes?: boolean;
  /**
   * The end customer this grant is being made for, asserted by the caller.
   * Its `user_id` resolves a `customer` member recorded as the connection's
   * `created_by_member_id`, so a partner can associate the connection with
   * their own caller rather than the agent member that made the API call.
   * Omit to attribute the grant to the authenticated principal.
   */
  identity?: RunIdentityInput;
  /**
   * Runtime selector (slug or runtime group id). Required by the server
   * (422) when the connector's provider is a chat provider — check
   * `connector.requires_runtime`.
   */
  runtime?: string;
  /**
   * MCP endpoint binding written with the grant. Requires `runtime`.
   */
  binding?: ConnectorAuthorizeBinding;
  /** Who the consent is for (default `"app"`). */
  subject?: ConnectionBrokerSubjectType;
  /** Where the browser lands after consent. */
  return_url?: string;
  /**
   * Seconds the URL stays valid (60–86400, server default 600). Raise it
   * when handing the URL to someone else to open.
   */
  expires_in?: number;
}

/**
 * A freshly minted consent URL. The URL embeds a single-use `state`, so it
 * must never be cached, and `state` itself is never surfaced as a field.
 */
export interface ConnectorAuthorizeResponse {
  authorize_url: string;
  expires_in: number;
  expires_at: IsoDate;
}

/**
 * A connection — one authorized subject under a connector. Access and
 * refresh tokens are never serialized.
 */
export interface Connection {
  id: Uuid;
  org_id: Uuid;
  created_at: IsoDate;
  updated_at: IsoDate;
  connector_id: Uuid;
  /**
   * `null` = org-owned (app subject); for a Slack workspace install this
   * points at the workspace customer member.
   */
  member_id?: Uuid | null;
  /**
   * The member who performed the grant, as distinct from `member_id` (whose
   * credential this is). For `app` and `workspace` subjects those are never
   * the same principal. `null` for grants made before the column existed.
   */
  created_by_member_id?: Uuid | null;
  /** Runtime group answering this connection's channels. */
  runtime_group_id?: Uuid | null;
  subject_type: ConnectionSubjectType;
  /**
   * App slug within a provider that fronts many apps from one host, as
   * `GET /v1/connectors/{id}/apps` returns it. `null` for a provider with a
   * dedicated host. Derived from the grant, never supplied on create.
   */
  provider_app?: string | null;
  /** The provider's own id for the connected account — an opaque routing id, not a secret. */
  provider_account_id?: string | null;
  /** Non-secret provider label captured on connection or re-consent. */
  metadata?: { name?: string };
  scopes_granted: string[];
  status: ConnectionStatus;
  token_expires_at?: IsoDate | null;
}

/** Registered-mode create — the caller supplies a provider token. */
export interface ConnectionCreateParams {
  access_token: string;
  /** Defaults to `"app"`. */
  subject_type?: ConnectionCreateSubjectType;
  scopes_granted?: string[];
  refresh_token?: string;
  token_expires_at?: IsoDate;
}

/** Deterministic, non-PII envelope for a person-authorized action. */
export interface ConnectionMissionConstraints {
  host?: string;
  /** Opaque or hashed resource identifier; never raw PII. */
  resource?: string;
  limits?: Record<string, unknown>;
  window_start?: IsoDate;
  window_end?: IsoDate;
  /** SHA-256 of the approved artifact. */
  payload_binding?: string;
}

export interface ConnectionTokenParams {
  /** Defaults to `"app"`. */
  subject?: ConnectionBrokerSubjectType;
  /**
   * The exact connection to use. When omitted, the platform resolves it from
   * the authenticated subject.
   */
  connection_id?: Uuid;
  /** Mission label shown to the human for person-authorized connectors. */
  action?: string;
  requested_permissions?: ConnectionMissionConstraints;
}

export interface ConnectionToken {
  token: string;
  token_type: string;
  expires_at?: IsoDate | null;
  scopes: string[];
}

export interface ConnectionAuthorizationPending {
  status: "authorization_pending";
  mission_id: Uuid;
  approval_url: string;
}

export type ConnectionTokenResult =
  ConnectionToken | ConnectionAuthorizationPending;

// --- app connections (`/v1/connections`, Data Plane) ---

/**
 * One app a member connected for themself. Distinct from {@link Connection},
 * which is a Control Plane connection nested under a connector.
 */
export interface AppConnection {
  id: Uuid;
  /** The member who connected the app. */
  member_id: Uuid;
  /** Provider application slug, such as `gmail`. */
  app: string;
  /** The provider's label for the connected account, when it has one. */
  account_name?: string | null;
  healthy: boolean;
  created_at: IsoDate;
}

/**
 * `GET /v1/connections` filters. A caller who is not an administrator always
 * gets only their own connections.
 */
export interface AppConnectionListParams extends CursorParams {
  /** Only this member's connections (administrators). */
  member_id?: Uuid;
  /** Only connections to this app slug. */
  app?: string;
}

/** `POST /v1/connections` body: connect one app for yourself. */
export interface AppConnectionCreateParams {
  /** Provider application slug, such as `gmail`. */
  app: string;
  /**
   * Runtime slug or group id whose sessions use the connection. A runner
   * fills in its own runtime group when this is omitted; the client needs it.
   */
  runtime?: string;
}

/**
 * A connect page for one app. The URL is single-use and ends on a page saying
 * the app is connected, so it must never be cached.
 */
export interface ConnectPage {
  authorize_url: string;
  expires_in: number;
  expires_at?: IsoDate | null;
}
