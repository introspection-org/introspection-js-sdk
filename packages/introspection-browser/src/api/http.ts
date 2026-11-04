/**
 * Browser HTTP transport for the Introspection Data Plane `/v1` surface.
 *
 * The request/response machinery — URL joining, query building, body
 * serialization, error mapping, AG-UI stream parsing — lives in the shared
 * `@introspection-sdk/http` {@link BaseHttpClient}. This module pins the
 * browser auth strategy on top of it: the DP is reached with an HttpOnly
 * session cookie minted by `POST /v1/oauth/exchange`, so every request opts
 * into `credentials: "include"` and sends NO bearer token — no Introspection
 * credential ever lives in JavaScript. A 401 (expired session cookie)
 * triggers a single `onUnauthorized` refresh + retry.
 *
 * The session cookie is a CP-signed `browser_session` JWT named per lane and
 * project — `intro_dp_{lane}_{base64url(project_uuid_bytes)}`, e.g.
 * `intro_dp_production_AZLVpGw-ehCAAAAAAAAAAQ` — so one browser holds a live
 * session for each lane and project it connected to. When more than one is
 * present the DP cannot tell which a request means, so we name it in the
 * {@link LANE_QUERY_PARAM} and {@link PROJECT_ID_QUERY_PARAM} query parameters;
 * with only the lane, the DP falls back to that lane's most recently issued
 * cookie. Query parameters rather than headers because a custom header makes
 * every cross-origin request pay a CORS preflight.
 */

import {
  BaseHttpClient,
  stripTrailingSlash,
  toApiError,
} from "@introspection-sdk/http";

import type { Environment } from "@introspection-sdk/types";

import { resolveBrowserFetch } from "./fetch.js";

// Re-exported for `client.ts`, which redeems the DP session on `connect()`.
export { stripTrailingSlash, toApiError };

/**
 * Query parameter naming which environment lane's session cookie the DP should
 * resolve.
 *
 * A selector, not a credential: the cookie it names is still validated
 * server-side, so naming a lane this browser holds no cookie for resolves to
 * nothing rather than granting anything.
 */
export const LANE_QUERY_PARAM = "lane";

/**
 * Query parameter naming which project's session cookie, within the lane, the
 * DP should resolve.
 *
 * A selector, not a credential: the cookie's own signed project is checked
 * against it server-side, so naming a project this browser holds no cookie for
 * is a 401 rather than access to that project.
 */
export const PROJECT_ID_QUERY_PARAM = "project_id";

/**
 * Header form of the lane selector, which the DP still accepts.
 *
 * @deprecated The client sends {@link LANE_QUERY_PARAM}; a custom header costs
 * a CORS preflight on every request.
 */
export const ENVIRONMENT_HEADER = "x-introspection-environment";

export interface BrowserHttpConfig {
  /** DP REST base URL every request is prefixed with. */
  apiUrl: string;
  /** Extra headers merged into every request. */
  additionalHeaders?: Record<string, string>;
  /** Custom `fetch` (for tests or non-standard runtimes). */
  fetch?: typeof fetch;
  /**
   * Invoked when a request comes back `401`. Return `true` if the DP
   * session was refreshed and the request should be retried once;
   * `false` to surface the original error.
   */
  onUnauthorized?: () => Promise<boolean>;
  /**
   * Reads the lane established by the most recent exchange.
   *
   * Called per request rather than captured at construction, because the lane
   * is not known until `connect()` resolves — and it can change under a
   * re-exchange.
   */
  environment?: () => Environment | undefined;
  /**
   * Reads the project established by the most recent exchange, read per
   * request for the same reason as {@link environment}. `undefined` against a
   * DP that does not return one, in which case only the lane is sent.
   */
  projectId?: () => string | undefined;
}

/**
 * Cookie-authenticated HTTP wrapper bound to one DP endpoint. Has no
 * opinion about which resource it serves — the caller picks the path.
 */
export class BrowserHttpClient extends BaseHttpClient {
  constructor(cfg: BrowserHttpConfig) {
    super({
      apiUrl: cfg.apiUrl,
      // Resolve a browser-safe `fetch` (native `fetch` brand-checks `this`).
      fetch: resolveBrowserFetch(cfg.fetch),
      additionalHeaders: cfg.additionalHeaders,
      transport: {
        // No bearer token and no header — the HttpOnly cookie is the
        // credential, and the lane and project selectors ride the URL.
        authHeaders: (): Record<string, string> => ({}),
        authQuery: (): Record<string, string> => {
          const query: Record<string, string> = {};
          const environment = cfg.environment?.();
          if (environment) query[LANE_QUERY_PARAM] = environment;
          const projectId = cfg.projectId?.();
          if (projectId) query[PROJECT_ID_QUERY_PARAM] = projectId;
          return query;
        },
        credentials: "include",
        onUnauthorized: cfg.onUnauthorized,
      },
    });
  }
}
