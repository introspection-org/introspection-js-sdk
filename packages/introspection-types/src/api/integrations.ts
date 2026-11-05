import type { IsoDate, Uuid } from "./common.js";

export type IntegrationType =
  "github" | "slack" | "linear" | "jira" | "notion" | "vercel" | "custom";

export type IntegrationStatus = "pending" | "active" | "error" | "disabled";

/**
 * The org's own install of a provider (a GitHub App installation, a Slack
 * workspace) at `/v1/integrations` (Control Plane). Org-wide, and at most one
 * live integration per `type` per org.
 */
export interface Integration {
  id: Uuid;
  org_id: Uuid;
  created_at: IsoDate;
  updated_at: IsoDate;
  type: IntegrationType;
  name?: string | null;
  /** The provider's id for the install, set once it is activated. */
  external_id?: string | null;
  status: IntegrationStatus;
  created_by_member_id: Uuid;
  token_expires_at?: IsoDate | null;
  data?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * `POST /v1/integrations` body. The row is created `pending`; the provider's
 * activation flow then sets `external_id` with an update.
 */
export interface IntegrationCreateParams {
  type: IntegrationType;
  name?: string;
  external_id?: string;
}

/**
 * `PATCH /v1/integrations/{id}` body. `code` and `redirect_uri` complete a
 * provider's OAuth activation.
 */
export interface IntegrationUpdateParams {
  name?: string;
  status?: IntegrationStatus;
  external_id?: string;
  code?: string;
  redirect_uri?: string;
  /** Only `false` is accepted: turns Slack interactivity off. */
  slack_interactivity_enabled?: false;
}

/** The level a provider permission is granted at. */
export type IntegrationPermissionLevel = "read" | "write";

/**
 * `POST /v1/integrations/{id}/access-token` body for a GitHub integration.
 * The server's cap allows only `{ metadata: "read" }` today.
 */
export interface GithubIntegrationAccessTokenParams {
  type: Extract<IntegrationType, "github">;
  /** GitHub App permission names, such as `metadata`. */
  permissions: Record<string, IntegrationPermissionLevel>;
}

/**
 * `POST /v1/integrations/{id}/access-token` body, discriminated on `type`,
 * which must match the integration's own. Add a member per provider the
 * server mints for (a `LinearIntegrationAccessTokenParams`, say).
 */
export type IntegrationAccessTokenParams = GithubIntegrationAccessTokenParams;

/**
 * A short-lived provider token (at most an hour), minted per request and
 * never stored by the server, so keep it only as long as it is needed.
 */
export interface IntegrationAccessToken {
  token: string;
  expires_at: IsoDate;
  type: IntegrationType;
  /** The permissions the provider granted. */
  permissions: Record<string, string>;
}
