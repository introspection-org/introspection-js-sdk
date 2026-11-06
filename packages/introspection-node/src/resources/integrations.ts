import type {
  CursorParams,
  Integration,
  IntegrationAccessToken,
  IntegrationAccessTokenParams,
  IntegrationCreateParams,
  IntegrationRepositories,
  IntegrationUpdateParams,
  Uuid,
} from "@introspection-sdk/types";
import { CollectionClient } from "@introspection-sdk/http";
import type { HttpClient } from "../http.js";

/**
 * `/v1/integrations` (Control Plane): the org's own provider installs (a
 * GitHub App installation, a Slack workspace). Org-wide, so no project
 * selector.
 *
 * A create returns a `pending` row, and answers 409 when an active or
 * disabled integration of the type already exists; the provider's
 * activation flow completes it with {@link update}. Gated on
 * `integrations:read` / `integrations:write` / `integrations:delete`, which
 * only an org credential carries.
 */
export class IntegrationsApi extends CollectionClient<
  Integration,
  IntegrationCreateParams,
  CursorParams
> {
  constructor(http: HttpClient) {
    super(http, "/v1/integrations", "Integration", "Paginated<Integration>");
  }

  update(
    integrationId: Uuid,
    params: IntegrationUpdateParams,
  ): Promise<Integration> {
    return this.http.request<Integration>({
      method: "PATCH",
      path: this.itemPath(integrationId),
      schema: "Integration",
      body: params,
    });
  }

  /**
   * Mint a short-lived provider token for the integration
   * (`integrations:token`). A request beyond the server's cap is refused,
   * never narrowed: a 403 whose `code` is `integration_token_cap_exceeded`,
   * with the allowed permissions in the error body's `detail.allowed`.
   */
  accessToken(
    integrationId: Uuid,
    params: IntegrationAccessTokenParams,
  ): Promise<IntegrationAccessToken> {
    return this.http.request<IntegrationAccessToken>({
      method: "POST",
      path: `${this.itemPath(integrationId)}/access-token`,
      schema: "IntegrationAccessToken",
      body: params,
    });
  }

  /**
   * The repositories the integration's installation can reach, all in one
   * response (`integrations:read`). The Control Plane reads them with its
   * own credential, so no provider token reaches the caller. A non-GitHub
   * integration is a `ValidationError`; an inactive one a `ConflictError`.
   */
  repositories(integrationId: Uuid): Promise<IntegrationRepositories> {
    return this.http.request<IntegrationRepositories>({
      method: "GET",
      path: `${this.itemPath(integrationId)}/repositories`,
      schema: "GithubInstallationRepositories",
    });
  }
}
