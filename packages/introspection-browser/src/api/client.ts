/**
 * Browser-side Introspection API client.
 *
 * Lets a single-page app create and stream Introspection tasks directly
 * from the browser, with no API key in JavaScript. The browser talks only
 * to the Data Plane — runtime resolution and any other Control Plane work
 * stays on the app's backend, so the CP never needs to serve CORS to
 * customer web origins. The auth boundary:
 *
 *   1. The SPA's own backend ("broker") mints a short-lived Introspection
 *      access token — via RFC 8693 token-exchange of the partner IdP
 *      token, a PKCE `authorization_code`, or `client_credentials` (the
 *      IdP secret never leaves the backend) — and, when a specific runtime
 *      is needed, resolves its `runtime_id` server-side. The SPA fetches
 *      the token through the `getToken` callback.
 *   2. `connect()` redeems the token at the DP `POST /v1/oauth/exchange`
 *      for an HttpOnly session cookie, named for the token's environment lane
 *      (`intro_dp_development` / `intro_dp_staging` / `intro_dp_production`).
 *      Distinct names mean an app running several lanes holds a live session
 *      for each in one browser instead of the newest evicting the last.
 *   3. Every subsequent call rides that cookie (`credentials: "include"`)
 *      — `client.tasks.start({ runtime_id })`, `.get(...)`, run streaming,
 *      etc.
 *
 * When the session cookie expires, an in-flight request gets a 401, and
 * the client transparently re-runs `getToken` + the DP exchange once
 * before retrying.
 */

import { BrowserHttpClient, stripTrailingSlash, toApiError } from "./http.js";
import { resolveBrowserFetch } from "./fetch.js";
import {
  ConversationsClient,
  FilesClient,
  SharesClient,
} from "@introspection-sdk/http";
import type { Environment } from "@introspection-sdk/types";
import { TasksClient } from "./tasks.js";

type CookieClients = {
  tasks: TasksClient;
  files: FilesClient;
  conversations: ConversationsClient;
  shares: SharesClient;
};

export interface IntrospectionApiClientOptions {
  /**
   * Data Plane REST base URL for the cookie-session APIs (`connect()` and
   * `client.tasks` / `client.files` / `client.conversations` /
   * `client.shares`). Required — the browser only talks to the DP.
   */
  dpUrl: string;
  /**
   * Returns a fresh Introspection access token from the app's broker
   * (its own backend). Called on `connect()` and again whenever the DP
   * session cookie needs re-minting after a 401. The session's project is
   * derived from this token's claims server-side — there is no separate
   * project option.
   */
  getToken: () => string | Promise<string>;
  /** Custom `fetch` (for tests or non-standard runtimes). */
  fetch?: typeof fetch;
  /** Extra headers merged into every DP request. */
  additionalHeaders?: Record<string, string>;
  /**
   * Environment lane this client talks to.
   *
   * Normally omit it. `connect()` learns the lane from the exchange response,
   * which the DP derives from the token's own `environment` claim — that is the
   * authoritative source, and it is why a client cannot simply declare a lane
   * it has no token for.
   *
   * Set it only to send the lane header before the first `connect()` resolves.
   * If it disagrees with the token, `connect()` throws rather than silently
   * preferring one.
   */
  environment?: Environment;
}

export class IntrospectionApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly cookieClients: CookieClients;
  /**
   * Lane established by the most recent exchange. Per instance, never module
   * scope — two clients on one page holding different lanes is the point.
   */
  private resolvedEnvironment?: Environment;
  /** The exchange currently in flight, shared by every concurrent 401. */
  private inFlightExchange?: Promise<boolean>;

  constructor(private readonly opts: IntrospectionApiClientOptions) {
    // Native browser `fetch` throws "Illegal invocation" when called as a
    // method of this client (`this.fetchImpl(...)`); resolveBrowserFetch
    // returns a global-safe wrapper. The same impl backs the connect()
    // exchange here and the cookie-session resource calls via BrowserHttpClient.
    this.fetchImpl = resolveBrowserFetch(opts.fetch);
    if (!opts.dpUrl) {
      throw new Error("IntrospectionApiClient requires a dpUrl");
    }
    this.resolvedEnvironment = opts.environment;
    const http = new BrowserHttpClient({
      apiUrl: opts.dpUrl,
      additionalHeaders: opts.additionalHeaders,
      fetch: this.fetchImpl,
      onUnauthorized: () => this.reexchange(),
      environment: () => this.resolvedEnvironment,
    });
    this.cookieClients = {
      tasks: new TasksClient(http),
      files: new FilesClient(http),
      conversations: new ConversationsClient(http),
      shares: new SharesClient(http),
    };
  }

  /** `/v1/tasks` operations bound to the DP session cookie. */
  get tasks(): TasksClient {
    return this.cookieClients.tasks;
  }

  /** `/v1/files` operations bound to the DP session cookie. */
  get files(): FilesClient {
    return this.cookieClients.files;
  }

  /** Read-only `/v1/conversations` projection bound to the session cookie. */
  get conversations(): ConversationsClient {
    return this.cookieClients.conversations;
  }

  /** `/v1/shares` read-sharing grants bound to the session cookie. */
  get shares(): SharesClient {
    return this.cookieClients.shares;
  }

  /**
   * Environment lane this client is connected to, once `connect()` has
   * resolved. `undefined` before the first exchange, unless the constructor
   * was given one.
   */
  get environment(): Environment | undefined {
    return this.resolvedEnvironment;
  }

  /**
   * Mint a token via `getToken` and redeem it at the DP for the session
   * cookie. Call once before issuing task requests.
   */
  async connect(): Promise<void> {
    await this.exchange();
  }

  private async exchange(): Promise<void> {
    const token = await this.opts.getToken();
    const res = await this.fetchImpl(
      `${stripTrailingSlash(this.opts.dpUrl)}/v1/oauth/exchange`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.opts.additionalHeaders ?? {}),
        },
        body: JSON.stringify({ token }),
        credentials: "include",
      },
    );
    if (!res.ok) throw await toApiError(res);

    // The DP echoes the lane it resolved from the token's claim, so the client
    // learns which cookie it just established without being told. Re-read on
    // every exchange, including the 401 recovery path: if the broker has since
    // switched lanes, a stale value would name a cookie we no longer hold.
    const body = (await res.json().catch(() => ({}))) as {
      environment?: Environment;
    };
    if (body.environment) {
      if (this.opts.environment && this.opts.environment !== body.environment) {
        throw new Error(
          `IntrospectionApiClient is configured for environment ` +
            `"${this.opts.environment}" but getToken() returned a token for ` +
            `"${body.environment}".`,
        );
      }
      this.resolvedEnvironment = body.environment;
    }
  }

  /**
   * 401 recovery: re-exchange, reporting success so the call can retry.
   *
   * Single-flight. Three requests failing 401 together used to call the
   * app's `getToken` three times and race three exchanges; if the broker
   * single-uses its tokens, the losers surfaced `AuthenticationError` even
   * though the session had just been refreshed.
   */
  private async reexchange(): Promise<boolean> {
    this.inFlightExchange ??= this.exchange()
      .then(() => true)
      .catch(() => false)
      .finally(() => {
        this.inFlightExchange = undefined;
      });
    return this.inFlightExchange;
  }
}
