import {
  RuntimesClient,
  type RuntimeRunRequest,
} from "@introspection-sdk/http";
import {
  ValidationError,
  type IsoDate,
  type RunnerContext,
  type RunnerDeployment,
} from "@introspection-sdk/types";
import type { HttpClient } from "../http.js";
import type { IntrospectionClient } from "../client.js";
import { Runner } from "../runner.js";

export type RuntimeDelegationRequest = RuntimeRunRequest & {
  /** OAuth scopes granted to the delegated Data Plane session. */
  scope: string;
};

/** Short-lived runtime authority intended for a trusted server-side broker. */
export interface RuntimeDelegation {
  token: string;
  deployment: RunnerDeployment;
  expires_at: IsoDate;
  context: RunnerContext;
}

export class RuntimesApi extends RuntimesClient<Runner> {
  constructor(
    http: HttpClient,
    private readonly client: IntrospectionClient,
  ) {
    super(http, (spec) => new Runner(this.client, spec));
  }

  /**
   * Create a short-lived runtime delegation for a trusted server-side broker.
   *
   * This Node-only operation exposes the session credential without
   * constructing a server-side {@link Runner}. Return its scoped,
   * identity-bound token only to the authenticated intended client; never
   * log it, persist it beyond `expires_at`, or share it broadly.
   */
  async delegate(
    request: RuntimeDelegationRequest,
  ): Promise<RuntimeDelegation> {
    if (typeof request.scope !== "string" || !request.scope.trim()) {
      throw new ValidationError({
        message: "`scope` must be a non-empty string",
        status: 422,
        code: "invalid_request",
      });
    }
    const scope = request.scope.trim();
    const spec = await this.postRun({ ...request, scope });
    return {
      token: spec.session_token,
      deployment: spec.deployment,
      expires_at: spec.expires_at,
      context: spec.runtime_context,
    };
  }
}

export function attachRuntimes(
  client: IntrospectionClient,
  http: HttpClient,
): RuntimesApi {
  return new RuntimesApi(http, client);
}
