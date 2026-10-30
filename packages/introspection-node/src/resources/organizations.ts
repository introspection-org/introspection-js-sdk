import type { Organization } from "@introspection-sdk/types";
import { ReadResource } from "./read-resource.js";

/** `/v1/organizations` (Control Plane): the credential's organization. */
export class OrganizationsApi extends ReadResource {
  /** The organization the credential belongs to. */
  me(): Promise<Organization> {
    return this.read<Organization>("/v1/organizations/me");
  }
}
