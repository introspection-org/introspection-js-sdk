import type { OidcMe } from "@introspection-sdk/types";
import { ReadResource } from "./read-resource.js";

/** `/v1/oidc` (Control Plane): who the client's credential signs in as. */
export class OidcApi extends ReadResource {
  /**
   * The member and org a member session or access token belongs to, with the
   * org's resolved feature flags.
   */
  me(): Promise<OidcMe> {
    return this.read<OidcMe>("/v1/oidc/me");
  }
}
