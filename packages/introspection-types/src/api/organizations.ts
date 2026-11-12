import type { Uuid } from "./common.js";

/** `GET /v1/organizations/me` response: the credential's organization. */
export interface Organization {
  id: Uuid;
  name: string;
  slug: string | null;
  external_org_id: string | null;
  image_url?: string | null;
  /** Whether the organization's projects host Git on their Data Plane. */
  hosted_git: boolean;
  /** Whether the subscription is paid and grants the organization's roles their full scopes. */
  subscription_live?: boolean;
  /** Present only where the organization has Enterprise sign-in. */
  sign_in?: SignInSettings | null;
}

/**
 * When an organization's members must sign in with a passkey. Open-ended: a
 * value this SDK version predates arrives as its raw string.
 */
export type PasskeyRequirement =
  "off" | "always" | "except_sso" | (string & Record<never, never>);

/** How an organization's members sign in and who can be invited. */
export interface SignInSettings {
  /** Server default `off`. */
  passkey_requirement: PasskeyRequirement;
  /** Server default `false`. */
  restrict_invites_to_domains: boolean;
}
