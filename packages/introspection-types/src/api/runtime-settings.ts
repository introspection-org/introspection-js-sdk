import type { CursorParams, Environment, IsoDate, Uuid } from "./common.js";
import type { ProjectRef } from "./projects.js";

/**
 * `GET /v1/credentials` and `GET /v1/variables` filters. A setting is scoped
 * to the project, a runtime group, a runtime, or one lane.
 */
export interface RuntimeSettingListParams extends CursorParams {
  project?: ProjectRef;
  runtime_id?: Uuid;
  /** A runtime slug. */
  runtime?: string;
  environment?: Environment;
}

/**
 * A runtime credential (`/v1/credentials`, Control Plane). The secret is
 * write-only: reads report only whether one is set and a display hint.
 */
export interface Credential {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  created_at: IsoDate;
  updated_at: IsoDate;
  name: string;
  runtime_id?: Uuid | null;
  runtime_group_id?: Uuid | null;
  /** `null` applies to every lane. */
  environment?: Environment | null;
  has_secret: boolean;
  secret_display?: string | null;
  secret_set_at?: IsoDate | null;
  created_by_member_id: Uuid;
}

/**
 * `POST /v1/credentials` body. With neither `runtime_id` nor
 * `runtime_group_id` the credential is project-wide.
 */
export interface CredentialCreateParams {
  name: string;
  secret: string;
  runtime_id?: Uuid;
  runtime_group_id?: Uuid;
  environment?: Environment;
}

/** `PATCH /v1/credentials/{id}` body. Set `secret` to rotate it. */
export interface CredentialUpdateParams {
  name?: string;
  secret?: string;
  runtime_id?: Uuid;
  runtime_group_id?: Uuid;
  environment?: Environment;
}

/**
 * `value` is a plain value, returned on read; `credential` references a
 * credential by name.
 */
export type VariableKind = "value" | "credential";

/** A runtime environment variable (`/v1/variables`, Control Plane). */
export interface Variable {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  created_at: IsoDate;
  updated_at: IsoDate;
  name: string;
  kind: VariableKind;
  value?: string | null;
  runtime_id?: Uuid | null;
  runtime_group_id?: Uuid | null;
  environment?: Environment | null;
  created_by_member_id: Uuid;
}

/** `POST /v1/variables` body. */
export interface VariableCreateParams {
  name: string;
  /** Defaults to `value`. */
  kind?: VariableKind;
  value?: string;
  runtime_id?: Uuid;
  runtime_group_id?: Uuid;
  environment?: Environment;
}

/** `PATCH /v1/variables/{id}` body. */
export interface VariableUpdateParams {
  name?: string;
  kind?: VariableKind;
  value?: string;
  runtime_id?: Uuid;
  runtime_group_id?: Uuid;
  environment?: Environment;
}
