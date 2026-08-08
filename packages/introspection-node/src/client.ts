/**
 * Introspection REST Client for Node.js
 *
 * Exposes the Control Plane REST surface for running runtimes and operating
 * experiments. Calling `client.runtimes(slug).run()` or
 * `client.experiments(id).run()` returns a {@link Runner} bound to a Data
 * Plane sandbox.
 *
 * This class is **REST-only** and does not depend on the OpenTelemetry
 * SDK. For event tracking, feedback, identify, and baggage context
 * helpers, use {@link IntrospectionLogs} from
 * `@introspection-sdk/introspection-node/otel`.
 */

import type { AdvancedOptions } from "@introspection-sdk/types";
import { logger as sdkLogger, USER_AGENT } from "./utils.js";
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
import {
  attachConnectors,
  type ConnectorsApi,
} from "./resources/connectors.js";
import { DEV_TARGET_HEADER, resolveDevTarget } from "./dev-target.js";

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
   * Read/resolve `/v1/runtimes` and open a runner with the callable handle.
   * Runtime lifecycle, version selection, and environment routing are managed
   * through the Introspection CLI and platform.
   */
  readonly runtimes: RuntimesApi & RuntimeHandleFactory;

  /**
   * Reads on `/v1/experiments` plus the `(id) => ExperimentHandle` factory
   * for run lifecycle. Authoring experiment definitions is a CLI action.
   */
  readonly experiments: ExperimentsApi & ExperimentHandleFactory;

  /**
   * Reads on `/v1/recipes`. Recipes are immutable build artefacts
   * (repository + git ref + commit sha) referenced by runtimes and
   * experiment arms; authoring them is a CLI action.
   */
  readonly recipes: RecipesApi;

  /**
   * CRUD on `/v1/connectors` (with connections nested under
   * `.connections`) plus `connectors.authorize(id)`, which mints the
   * single-use consent URL a Business hands its customer.
   */
  readonly connectors: ConnectorsApi;

  constructor(options: IntrospectionClientOptions = {}) {
    const token = options.token || process.env.INTROSPECTION_TOKEN || "";
    const advanced = options.advanced || {};
    const baseApiUrl =
      advanced.baseApiUrl ||
      process.env.INTROSPECTION_BASE_API_URL ||
      "https://api.introspection.dev";

    if (!token) {
      sdkLogger.warn(
        "IntrospectionClient: No token provided. REST calls will fail.",
      );
    }

    // INTROSPECTION_DEV_TARGET rides every request as a header so it reaches
    // the paths a runner cannot: a bare `POST /v1/tasks` with a dev API key
    // mints its JWT from the key row and has no per-request claim to carry.
    // Merged first, so an explicit `additionalHeaders` entry still wins, and
    // stored on advancedOptions so the Runner's own DP client inherits it.
    const devTarget = resolveDevTarget();
    // `User-Agent` is set here rather than in the shared HTTP client because
    // that client also backs the browser package, where the header is
    // forbidden and the request would be rejected. On Node it identifies the
    // SDK and its release on REST calls the way it already does on the two
    // OTLP streams, and rides `advancedOptions` so the Runner's DP client
    // inherits it. Merged first, so an explicit `additionalHeaders` wins.
    const additionalHeaders = {
      "User-Agent": USER_AGENT,
      ...(devTarget ? { [DEV_TARGET_HEADER]: devTarget } : {}),
      ...advanced.additionalHeaders,
    };
    this.advancedOptions = { ...advanced, additionalHeaders };

    // CP HTTP client — talks to the customer-facing API with the customer
    // API key. Runners get their own HttpClient instances pointed at the
    // `deployment.endpoint` returned by `/v1/runtimes/{id}/run`.
    this.cpHttp = new HttpClient({
      apiUrl: baseApiUrl,
      token,
      additionalHeaders: this.advancedOptions.additionalHeaders,
      fetch: advanced.fetch,
    });

    this.runtimes = attachRuntimes(this, this.cpHttp);
    this.experiments = attachExperiments(this, this.cpHttp);
    this.recipes = attachRecipes(this.cpHttp);
    this.connectors = attachConnectors(this.cpHttp);

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
   *   project: process.env.INTRO_PROJECT!,
   * });
   *
   * // Resolved fresh from the runtime slug on every call.
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
