import type {
  CursorParams,
  Integration,
  IntegrationCreateParams,
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
    super(http, "/v1/integrations");
  }

  update(
    integrationId: Uuid,
    params: IntegrationUpdateParams,
  ): Promise<Integration> {
    return this.http.request<Integration>({
      method: "PATCH",
      path: this.itemPath(integrationId),
      body: params,
    });
  }
}
