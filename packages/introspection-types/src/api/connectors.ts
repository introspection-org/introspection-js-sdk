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

/**
 * How callers of a `webhook` connector authenticate: `standard_webhooks`
 * (the default) signs each call per the Standard Webhooks spec with the
 * connector's secret; `bearer` sends the secret as a bearer token.
 */
export type WebhookAuth =
  "standard_webhooks" | "bearer" | (string & Record<never, never>);

export type ConnectionStatus =
  "pending_authorization" | "active" | "refresh_failed" | "revoked";

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
 * and update, absent from every read — this read model deliberately does
 * not declare them. A `webhook` connector's platform-generated secret is
 * returned once, by the create or rotation that issues it
 * ({@link ConnectorSecretResponse}).
 *
 * A `webhook` connector (`provider: "webhook"`, `auth_mode: "static"`) is
 * inbound only: the customer's own systems call
 * `POST /v1/webhooks/connectors/{id}` on the Control Plane, and a routine
 * trigger with `source: "connector"` and its `connector_slug` runs on each
 * call.
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
  /** How a `webhook` connector's callers authenticate; null for every other provider. */
  webhook_auth?: WebhookAuth | null;
  /**
   * For a rotated `webhook` connector: until when its previous secret is
   * still accepted (24 hours after the rotation).
   */
  previous_signing_secret_expires_at?: IsoDate | null;
}

/**
 * A connector create or update response. `signing_secret` is a `webhook`
 * connector's new secret, present only on the create that generates it and
 * on an update with `rotate_signing_secret: true`. Shown once: store it, as
 * no read returns it.
 */
export interface ConnectorSecretResponse extends Connector {
  signing_secret?: string;
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
  /**
   * A `webhook` connector only (server default `standard_webhooks`). A
   * webhook connector takes no secret, client, hosts, scopes or endpoints:
   * the platform generates its secret.
   */
  webhook_auth?: WebhookAuth;
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
  /** A `webhook` connector only: how its callers authenticate. */
  webhook_auth?: WebhookAuth;
  /**
   * A `webhook` connector only: issue a new secret, returned once as the
   * response's `signing_secret`. The previous one stays valid for 24 hours
   * (`previous_signing_secret_expires_at`).
   */
  rotate_signing_secret?: boolean;
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
  /** RFC 7009 token revocation endpoint, if advertised. */
  revocation_endpoint?: string | null;
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
   * An organization integration to install (Google Workspace, Microsoft
   * 365) instead of a connector. Needs `integrations:write`.
   */
  integration_id?: Uuid;
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

/** The connector an {@link AppConnection} is on, as the project sees it. */
export interface AppConnectionConnector {
  id: Uuid;
  slug: string;
  provider: string;
  /** The peering the project reaches the connector through, if any. */
  peering?: string | null;
}

/**
 * One connection on the project's connectors: an app a member connected for
 * themself, or the project's own account.
 */
export interface AppConnection {
  /** The connection's id. Get and delete also take `provider_account_id`. */
  id: string;
  /** A member's own grant, or the project's. */
  owner?: "member" | "project";
  /** The member whose grant this is; null for the project's own. */
  member_id: Uuid | null;
  connector?: AppConnectionConnector | null;
  subject_type?: string | null;
  /** Provider application slug, such as `gmail`, or the connector's slug. */
  app: string;
  /** The organization integration it is through; absent for a connector's. */
  integration_id?: Uuid | null;
  /** The runtime group whose channels it answers, if any. */
  runtime_group_id?: Uuid | null;
  /** When the access token expires, if it does. */
  token_expires_at?: IsoDate | null;
  /** The provider's id for the account, such as `apn_...`. */
  provider_account_id?: string | null;
  /** The provider's label for the connected account, when it has one. */
  account_name?: string | null;
  healthy: boolean;
  status?: string | null;
  last_verified_at?: IsoDate | null;
  created_by_member_id?: Uuid | null;
  created_at: IsoDate;
  updated_at?: IsoDate | null;
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
  /** Only connections on this connector. */
  connector_id?: Uuid;
  /** Only members' own connections through this organization integration. */
  integration_id?: Uuid;
  /**
   * Only accounts whose name, such as an email, contains this (1 to 128
   * characters, case-insensitive).
   */
  search?: string;
  /** Only connections of this subject. */
  subject_type?: "user" | "federated" | "workspace" | "person" | "app";
  /** Only connectors reached through this peering. */
  peering?: string;
}

/** `POST /v1/connections` body: connect one app for yourself. */
export interface AppConnectionCreateParams {
  /** Provider application slug, such as `gmail`. Exclusive with `integration_id`. */
  app?: string;
  /**
   * Connect your own account through this organization integration, once
   * for every project that allows its type. Exclusive with `app`.
   */
  integration_id?: Uuid;
  /**
   * Runtime slug or group id whose sessions use the connection. A runner
   * fills in its own runtime group when this is omitted; the client needs it.
   */
  runtime?: string;
  /**
   * The app's own link the connect page ends on, such as `ark://connected`.
   * The Control Plane admits only the app schemes it allows.
   */
  return_url?: string | null;
}

/**
 * A connect page for one app. The URL is single-use and ends on the request's
 * `return_url` or on a page saying the app is connected, so it must never be
 * cached.
 */
export interface ConnectPage {
  authorize_url: string;
  expires_in: number;
  expires_at?: IsoDate | null;
}
