// Connectors & connections — B2B2C outbound provider access.
//
// A *connector* is the org-side definition of a provider (endpoints, creds,
// policy). A *connection* is the concrete authorized instance it produces.
// External backends mint a raw token via `client.connections.getToken`;
// in-sandbox agents call `runner.connections.authorize` and the token is
// materialized into the session + injected at egress (never held raw).

import type { IsoDate, ListParams, Uuid } from "./api.js";

/** Whose authority a minted token carries. */
export type ConnectionSubject = "app" | "user" | "person";

/** How a connector sources its token. */
export type ConnectorAuthMode =
  | "static"
  | "oauth_stored"
  | "identity_assertion"
  | "federated_exchange"
  | "person_authorized";

export type ConnectorStatus = "pending" | "active" | "error";

/**
 * The per-action envelope a human approves for a `person_authorized`
 * connector. PII-free: `resource` is an opaque/hashed lock, never a raw
 * recipient. Enforced byte-exact at the egress boundary.
 */
export interface MissionConstraints {
  /** Opaque/hashed recipient or resource lock — never raw PII. */
  resource?: string;
  /** e.g. `{ amount_max, count }`. */
  limits?: { amount_max?: number; count?: number };
  /** Grant validity window. */
  window?: { start?: IsoDate; end?: IsoDate };
  /** Request-audience host lock. */
  host?: string;
}

/** A connector — the org-side definition of an outbound provider. */
export interface Connector {
  id: Uuid;
  slug: string;
  name: string;
  provider: string;
  auth_mode: ConnectorAuthMode;
  subject_scope: "org" | "member";
  scopes: string[];
  api_hosts: string[];
  status: ConnectorStatus;
  created_at: IsoDate;
  updated_at: IsoDate;
}

export interface ConnectorCreate {
  /** Stable per-org identifier; derived from `name` when omitted. */
  slug?: string;
  name: string;
  provider: string;
  auth_mode: ConnectorAuthMode;
  scopes?: string[];
  api_hosts?: string[];
  authorization_endpoint?: string | null;
  token_endpoint?: string | null;
  client_id?: string | null;
  client_secret?: string | null;
}

export interface ConnectorUpdate {
  name?: string;
  scopes?: string[];
  api_hosts?: string[];
  status?: ConnectorStatus;
}

export interface ConnectorListParams extends ListParams {
  auth_mode?: ConnectorAuthMode;
}

/** A connection — a connected token instance against a connector. */
export interface Connection {
  id: Uuid;
  connector_id: Uuid;
  subject_type: "app" | "user" | "federated" | "person";
  status: "pending_authorization" | "active" | "refresh_failed" | "revoked";
  scopes_granted: string[];
  created_at: IsoDate;
  updated_at: IsoDate;
}

// ── getToken (CP — external backends that call providers directly) ──────────

export interface GetTokenParams {
  /** Operation/scope requested, e.g. "gmail.send" / "booking.reserve". */
  action?: string;
  subject?: ConnectionSubject;
  /** Per-action envelope for `person_authorized`. */
  mission?: MissionConstraints;
}

/** Pending is a first-class outcome, never thrown. */
export type GetTokenResult =
  | {
      status: "granted";
      token: string;
      token_type: string;
      expires_at?: IsoDate;
      scopes: string[];
    }
  | { status: "pending"; mission_id: Uuid; approval_url: string };

// ── authorize (DP — in-sandbox agent; token injected at egress) ─────────────

export interface AuthorizeParams {
  action: string;
  subject?: ConnectionSubject;
  mission?: MissionConstraints;
}

/**
 * The result of ensuring a grant. The raw token is **not** returned — it is
 * materialized into the session and injected at egress. A `pending` grant
 * carries a hosted `approval_url`.
 */
export type Grant =
  | {
      status: "granted";
      connector: string;
      scopes: string[];
      expires_at?: IsoDate;
    }
  | { status: "pending"; mission_id: Uuid; approval_url: string };

export type GrantedGrant = Extract<Grant, { status: "granted" }>;
