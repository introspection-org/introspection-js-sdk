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
 * The session cookie is named for its environment lane
 * (`intro_dp_development` / `intro_dp_staging` / `intro_dp_production`), so an
 * app running several lanes holds a live session for each in one browser. When
 * more than one is present the DP cannot tell which a request means, so we name
 * it in {@link ENVIRONMENT_HEADER}.
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
 * Names which environment lane's session cookie the DP should resolve.
 *
 * A selector, not a credential: the cookie it names is still validated
 * server-side, so naming a lane this browser holds no cookie for resolves to
 * nothing rather than granting anything.
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
        // Still no bearer token — the HttpOnly cookie is the credential. The
        // only per-request contribution is which lane's cookie to resolve.
        authHeaders: (): Record<string, string> => {
          const environment = cfg.environment?.();
          return environment ? { [ENVIRONMENT_HEADER]: environment } : {};
        },
        credentials: "include",
        onUnauthorized: cfg.onUnauthorized,
      },
    });
  }
}
