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
}
