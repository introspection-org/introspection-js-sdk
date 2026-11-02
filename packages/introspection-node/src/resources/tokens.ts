import type {
  DataPlaneToken,
  TokenCreateParams,
} from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";

/** `/v1/tokens` (Control Plane): Data Plane tokens for one project. */
export class TokensApi {
  constructor(private readonly http: HttpClient) {}

  /**
   * Mint a Data Plane token for `params.project`, carrying the caller's
   * scopes. A member's token is the one credential that carries `git:push`
   * to a hosted repository.
   */
  create(params: TokenCreateParams): Promise<DataPlaneToken> {
    return this.http.request<DataPlaneToken>({
      method: "POST",
      path: "/v1/tokens",
      body: params,
    });
  }
}
