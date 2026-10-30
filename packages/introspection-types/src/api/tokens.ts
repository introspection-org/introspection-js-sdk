import type { Environment, IsoDate, Uuid } from "./common.js";
import type { ProjectRef } from "./projects.js";

/** `POST /v1/tokens` body: a Data Plane token for one project. */
export interface TokenCreateParams {
  /** Project slug or id. */
  project: ProjectRef;
  /** Lifetime in hours, 1–720. */
  expires_hours?: number | null;
  /** Lifetime in minutes, 1–60; for a token shorter than an hour. */
  expires_minutes?: number | null;
  /** Also issue a refresh token for the `refresh_token` grant. */
  include_refresh_token?: boolean;
  /**
   * The lane the token belongs to. Only a member's own session may name a
   * lane other than its credential's.
   */
  environment?: Environment | null;
}

/** `POST /v1/tokens` response. */
export interface DataPlaneToken {
  access_token: string;
  token_type: string;
  expires_at: IsoDate;
  project_id: Uuid;
  org_id: Uuid;
  /** Set only when `include_refresh_token` was asked for. */
  refresh_token?: string | null;
}
