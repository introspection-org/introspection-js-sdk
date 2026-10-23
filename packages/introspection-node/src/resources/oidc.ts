import type { OidcMe } from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";

/** `/v1/oidc` (Control Plane): who the client's credential signs in as. */
export class OidcApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * The member and org a member session or access token belongs to, with the
   * org's resolved feature flags.
   */
  me(): Promise<OidcMe> {
    return this.http.request<OidcMe>({ method: "GET", path: "/v1/oidc/me" });
  }
}
