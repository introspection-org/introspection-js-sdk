import type { Environment, IsoDate, Uuid } from "./common.js";
import type { ProjectRef } from "./projects.js";

/** What a project API key may do beyond the runner set. */
export type ApiKeyCapability = "runtimes" | "evals";

/**
 * `rotating` is a key deleted with a grace period: it still works until
 * `expires_at`.
 */
export type ApiKeyStatus = "active" | "rotating" | "expired" | "revoked";

/**
 * A project API key (`/v1/api-keys`, Control Plane). The plaintext is never
 * readable after create; see {@link ApiKeyCreated}.
 */
export interface ApiKey {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  created_at: IsoDate;
  name?: string | null;
  environment: Environment;
  allow: ApiKeyCapability[];
  scope: string;
  /** The agent member the key acts as, when it is not the default one. */
  member_id?: Uuid | null;
  key_prefix: string;
  key_suffix: string;
  redacted_key?: string | null;
  status: ApiKeyStatus;
  expires_at?: IsoDate | null;
  last_used_at?: IsoDate | null;
  /** Set once `apiKeys.acknowledge()` records the plaintext as saved. */
  acknowledged_at?: IsoDate | null;
  key_display: string;
  prefix: string;
}

/**
 * `POST /v1/api-keys` response: the key plus its plaintext `api_key`, the
 * only time the API returns it.
 */
export interface ApiKeyCreated extends ApiKey {
  api_key?: string | null;
}

/** `GET /v1/api-keys` filters. The route is not paginated. */
export interface ApiKeyListParams {
  project?: ProjectRef;
  /** Only keys close to expiry. */
  expiring?: boolean;
}

/** `POST /v1/api-keys` body. */
export interface ApiKeyCreateParams {
  name?: string;
  /** Defaults to `production`. */
  environment?: Environment;
  allow?: ApiKeyCapability[];
  /** Act as this external-credential agent rather than the default one. */
  member_id?: Uuid;
  expires_at?: IsoDate;
}

/** `PATCH /v1/api-keys/{id}` body. */
export interface ApiKeyUpdateParams {
  name?: string;
  allow?: ApiKeyCapability[];
  member_id?: Uuid;
}

/** `DELETE /v1/api-keys/{id}` query. */
export interface ApiKeyDeleteParams {
  project?: ProjectRef;
  /**
   * Keep the key working this many more seconds (a rotation); omit or `0`
   * to revoke it at once.
   */
  expires_in?: number;
}

/** `POST /v1/api-keys/{id}/acknowledge` response. */
export interface ApiKeyAcknowledgement {
  acknowledged: boolean;
}
