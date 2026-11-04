import type { CursorParams, Environment, IsoDate, Uuid } from "./common.js";
import type { ProjectRef } from "./projects.js";

export type ApplicationType = "native" | "spa" | "jwks" | "service_account";

export type ApplicationGrant =
  | "authorization_code"
  | "refresh_token"
  | "client_credentials"
  | "device_code"
  | "email_code";

/** An OAuth client registered in a project (`/v1/applications`, Control Plane). */
export interface Application {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  created_at: IsoDate;
  updated_at: IsoDate;
  name: string;
  application_type: ApplicationType;
  environment: Environment;
  redirect_uris: string[];
  allowed_origins: string[];
  allowed_scopes: string[];
  client_id: string;
  agent_member_id?: Uuid | null;
  allowed_grants: ApplicationGrant[];
  last_used_at?: IsoDate | null;
  revoked_at?: IsoDate | null;
  created_by_member_id: Uuid;
}

/** `GET /v1/applications` filters. */
export interface ApplicationListParams extends CursorParams {
  project?: ProjectRef;
}

/** `POST /v1/applications` body. */
export interface ApplicationCreateParams {
  name: string;
  application_type: ApplicationType;
  environment?: Environment;
  redirect_uris?: string[];
  allowed_origins?: string[];
  allowed_scopes?: string[];
  agent_member_id?: Uuid;
}

/** `PATCH /v1/applications/{id}` body. A list replaces the whole value. */
export interface ApplicationUpdateParams {
  name?: string;
  redirect_uris?: string[];
  allowed_origins?: string[];
  allowed_scopes?: string[];
  agent_member_id?: Uuid;
}

export type ApplicationIdpProvider =
  "auth0" | "okta" | "supabase" | "neon" | "generic" | "zitadel";

export type ApplicationIdpStatus = "pending" | "active" | "failed";

/**
 * An identity provider brokered into an Application, whose users sign in as
 * customer members.
 */
export interface ApplicationIdp {
  id: Uuid;
  org_id: Uuid;
  application_id: Uuid;
  created_at: IsoDate;
  updated_at: IsoDate;
  idp_provider: ApplicationIdpProvider;
  issuer: string;
  client_id: string;
  scopes: string[];
  external_org_id?: string | null;
  external_idp_id?: string | null;
  audience_client_id?: string | null;
  status: ApplicationIdpStatus;
  error_message?: string | null;
  disabled_at?: IsoDate | null;
  client_secret?: string | null;
  is_active: boolean;
}

/** `POST /v1/applications/{id}/idps` body. */
export interface ApplicationIdpCreateParams {
  /** Defaults to `generic`. */
  idp_provider?: ApplicationIdpProvider;
  issuer?: string;
  client_id?: string;
  client_secret?: string;
  scopes?: string[];
  audience_client_id?: string;
}

export type ApplicationSecretStatus = "active" | "disabled" | "expired";

/**
 * A client secret of a confidential Application. `secret` (the plaintext)
 * is set only on the create response.
 */
export interface ApplicationSecret {
  id: Uuid;
  org_id: Uuid;
  application_id: Uuid;
  created_at: IsoDate;
  updated_at: IsoDate;
  secret_prefix: string;
  secret_suffix: string;
  name?: string | null;
  expires_at?: IsoDate | null;
  disabled_at?: IsoDate | null;
  last_used_at?: IsoDate | null;
  created_by_member_id: Uuid;
  secret?: string | null;
  status: ApplicationSecretStatus;
}

/** `POST /v1/applications/{id}/secrets` body. */
export interface ApplicationSecretCreateParams {
  name?: string;
}

/**
 * A signing key of a `jwks` Application: the public half, published at the
 * Application's JWKS URL.
 */
export interface ApplicationKey {
  id: Uuid;
  org_id: Uuid;
  application_id: Uuid;
  created_at: IsoDate;
  updated_at: IsoDate;
  kid: string;
  algorithm: string;
  public_key: string;
  created_by_member_id?: Uuid | null;
}
