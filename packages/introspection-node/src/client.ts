/**
 * Introspection REST Client for Node.js
 *
 * Exposes the Control Plane REST surface for managing runtimes and
 * experiments. Calling `client.runtimes(name).run()` or
 * `client.experiments(id).run()` returns a {@link Runner} bound to a Data
 * Plane sandbox.
 *
 * This class is **REST-only** and does not depend on the OpenTelemetry
 * SDK. For event tracking, feedback, identify, and baggage context
 * helpers, use {@link IntrospectionLogs} from
 * `@introspection-sdk/introspection-node/otel`.
 */

import type { AdvancedOptions } from "@introspection-sdk/types";
import { logger as sdkLogger } from "./utils.js";
import type { IntrospectionClientOptions } from "./types.js";
import { serviceAccountToken, type ServiceAccountTokenParams } from "./auth.js";
import { HttpClient } from "./http.js";
import {
  attachRuntimes,
  type RuntimeHandleFactory,
  type RuntimesApi,
} from "./resources/runtimes.js";
import {
  attachExperiments,
  type ExperimentHandleFactory,
  type ExperimentsApi,
} from "./resources/experiments.js";
import { attachRecipes, type RecipesApi } from "./resources/recipes.js";

/**
 * Introspection REST client.
 *
 * @example
 * ```typescript
 * const client = new IntrospectionClient({
 *   token: process.env.INTROSPECTION_TOKEN,
 * });
 *
 * // Open a runner from a runtime, then drive it.
 * const runner = await client.runtimes("customer-agent").run({
 *   identity: { user_id: "u_42" },
 * });
 * const run = await runner.tasks.create({ prompt: "Summarize this repo" });
 * for await (const ev of run.stream()) console.log(ev.type);
 *
 * await runner.close();
 * await client.shutdown();
 * ```
 */
export class IntrospectionClient {
  /** @internal — HTTP client pointed at the CP API with the customer key. */
  readonly cpHttp: HttpClient;
  /** @internal — passed through to Runner so it can build its own DP HTTP client. */
  readonly advancedOptions: AdvancedOptions;

  /**
   * CRUD on `/v1/runtimes` and the `(idOrName) => RuntimeHandle` factory.
   * Call as `client.runtimes("customer-agent").run()`. The project is taken
   * from the API key server-side; pass `project_id` to a CRUD helper only to
   * override it per call.
   */
  readonly runtimes: RuntimesApi & RuntimeHandleFactory;

  /**
   * CRUD on `/v1/experiments` and the `(id) => ExperimentHandle` factory.
   */
  readonly experiments: ExperimentsApi & ExperimentHandleFactory;

  /**
   * CRUD on `/v1/recipes`. Recipes are immutable build artefacts
   * (repository + git ref + commit sha) referenced by runtimes and
   * experiment arms.
   */
  readonly recipes: RecipesApi;

  constructor(options: IntrospectionClientOptions = {}) {
    const token = options.token || process.env.INTROSPECTION_TOKEN || "";
    const advanced = options.advanced || {};
    this.advancedOptions = advanced;
    const baseApiUrl =
      advanced.baseApiUrl ||
      process.env.INTROSPECTION_BASE_API_URL ||
      "https://api.introspection.dev";

    if (!token) {
      sdkLogger.warn(
        "IntrospectionClient: No token provided. REST calls will fail.",
      );
    }

    // CP HTTP client — talks to the customer-facing API with the customer
    // API key. Runners get their own HttpClient instances pointed at the
    // `deployment.endpoint` returned by `/v1/runtimes/{id}/run`.
    this.cpHttp = new HttpClient({
      apiUrl: baseApiUrl,
      token,
      additionalHeaders: advanced.additionalHeaders,
      fetch: advanced.fetch,
    });

    this.runtimes = attachRuntimes(this, this.cpHttp);
    this.experiments = attachExperiments(this, this.cpHttp);
    this.recipes = attachRecipes(this.cpHttp);

    sdkLogger.info(`IntrospectionClient initialized: api=${baseApiUrl}`);
  }

  /**
   * Authenticate as a confidential service account and return a ready
   * client.
   *
   * Mints a short-lived, project-scoped CP access token via the
   * `client_credentials` grant (see {@link serviceAccountToken}) and wires
   * it in as the bearer token, so the runtime flow works exactly as it does
   * with an API key:
   *
   * @example
   * ```typescript
   * const client = await IntrospectionClient.fromServiceAccount({
   *   clientId: process.env.INTROSPECTION_SERVICE_ACCOUNT_CLIENT_ID!,
   *   clientSecret: process.env.INTROSPECTION_SERVICE_ACCOUNT_CLIENT_SECRET!,
   *   projectId: process.env.INTRO_PROJECT_ID!,
   * });
   *
   * // Resolved fresh from the runtime name on every call.
   * const runner = await client.runtimes("customer-agent").run({
   *   identity: { user_id: "u_demo" },
   * });
   * ```
   *
   * The token is not auto-refreshed: it lives for `expires_in` seconds, so
   * re-mint (call this again) for long-lived processes once it lapses.
   */
  static async fromServiceAccount(
    params: ServiceAccountTokenParams & { serviceName?: string },
  ): Promise<IntrospectionClient> {
    const { access_token } = await serviceAccountToken(params);
    return new IntrospectionClient({
      token: access_token,
      serviceName: params.serviceName,
      advanced: { baseApiUrl: params.baseApiUrl, fetch: params.fetch },
    });
  }

  /** Close the underlying HTTP client. */
  async shutdown(): Promise<void> {
    // HttpClient has no persistent connections to close, but reserved
    // for future use (e.g. agent keep-alive pools).
    sdkLogger.debug("IntrospectionClient shutdown complete");
  }
}
