import type { Uuid } from "./common.js";

/** A feature flag's resolved value. */
export type FeatureFlagValue = boolean | number | string;

/** `GET /v1/oidc/me` response: who the credential signs in as. */
export interface OidcMe {
  authenticated: boolean;
  org_id?: Uuid | null;
  member_id?: Uuid | null;
  email?: string | null;
  name?: string | null;
  picture?: string | null;
  /** The org's resolved feature flags. */
  feature_flags: Record<string, FeatureFlagValue>;
  /** Set while an operator impersonates this member. */
  impersonating_member_id?: Uuid | null;
  impersonator_email?: string | null;
}
