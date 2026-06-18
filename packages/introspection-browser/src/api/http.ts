/**
 * Browser HTTP transport for the Introspection Data Plane `/v1` surface.
 *
 * The request/response machinery — URL joining, query building, body
 * serialization, error mapping, SSE — lives in the shared
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

export type BrowserApiHttpClient = Pick<BaseHttpClient, "request" | "stream">;

/**
 * Cookie-authenticated HTTP wrapper bound to one DP endpoint. Has no
 * opinion about which resource it serves — the caller picks the path.
 */
export class BrowserHttpClient extends BaseHttpClient {
  constructor(cfg: BrowserHttpConfig) {
    super({
      apiUrl: cfg.apiUrl,
      additionalHeaders: cfg.additionalHeaders,
      fetch: cfg.fetch,
      transport: {
        authHeaders: () => ({}),
        credentials: "include",
        onUnauthorized: cfg.onUnauthorized,
      },
    });
  }
}

export interface BrowserBearerHttpConfig {
  /** REST base URL every request is prefixed with. */
  apiUrl: string;
  /** Bearer token, or a provider returning the latest token before each request. */
  token: string | (() => string | Promise<string>);
  /** Extra headers merged into every request. */
  additionalHeaders?: Record<string, string>;
  /** Custom `fetch` (for tests or non-standard runtimes). */
  fetch?: typeof fetch;
}

/**
 * Bearer-authenticated browser HTTP wrapper. Used for CP runtime calls with
 * brokered access tokens and for DP runner calls with CP-minted runner tokens.
 */
export class BrowserBearerHttpClient extends BaseHttpClient {
  private readonly tokenBox: { value: string };
  private readonly getToken?: () => string | Promise<string>;

  constructor(cfg: BrowserBearerHttpConfig) {
    const tokenBox = { value: typeof cfg.token === "string" ? cfg.token : "" };
    super({
      apiUrl: cfg.apiUrl,
      additionalHeaders: cfg.additionalHeaders,
      fetch: cfg.fetch,
      transport: {
        authHeaders: (): Record<string, string> => {
          if (!tokenBox.value) return {};
          return { Authorization: `Bearer ${tokenBox.value}` };
        },
      },
    });
    this.tokenBox = tokenBox;
    this.getToken = typeof cfg.token === "function" ? cfg.token : undefined;
  }

  private async refreshToken(): Promise<void> {
    if (!this.getToken) return;
    this.tokenBox.value = await this.getToken();
  }

  async request<T>(opts: Parameters<BaseHttpClient["request"]>[0]): Promise<T> {
    await this.refreshToken();
    return super.request<T>(opts);
  }

  async stream(
    opts: Parameters<BaseHttpClient["stream"]>[0],
  ): Promise<Response> {
    await this.refreshToken();
    return super.stream(opts);
  }
}
