/**
 * Browser HTTP transport for the Introspection Data Plane `/v1` surface.
 *
 * The request/response machinery — URL joining, query building, body
 * serialization, error mapping, AG-UI stream parsing — lives in the shared
 * `@introspection-sdk/http` {@link BaseHttpClient}. This module pins the
 * browser auth strategy on top of it: the DP is reached with the HttpOnly
 * `intro_dp_session` cookie minted by `POST /v1/oauth/exchange`, so every
 * request opts into `credentials: "include"` and sends NO bearer token —
 * no Introspection credential ever lives in JavaScript. A 401 (expired
 * session cookie) triggers a single `onUnauthorized` refresh + retry.
 */

import {
  BaseHttpClient,
  stripTrailingSlash,
  toApiError,
} from "@introspection-sdk/http";

import { resolveBrowserFetch } from "./fetch.js";

// Re-exported for `client.ts`, which redeems the DP session on `connect()`.
export { stripTrailingSlash, toApiError };

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
        authHeaders: () => ({}),
        credentials: "include",
        onUnauthorized: cfg.onUnauthorized,
      },
    });
  }
}
