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
 *      for the HttpOnly `intro_dp_session` cookie.
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
   * Development Link secret (`dl_…`) pairing this app instance to a local
   * recipe checkout. Sent as `Introspection-Development-Link` on
   * task-creating requests only. Explicit option only in the browser —
   * there is no environment fallback; forward it from your backend broker
   * alongside the token when needed.
   */
  developmentLink?: string;
}

export class IntrospectionApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly cookieClients: CookieClients;

  constructor(private readonly opts: IntrospectionApiClientOptions) {
    // Native browser `fetch` throws "Illegal invocation" when called as a
    // method of this client (`this.fetchImpl(...)`); resolveBrowserFetch
    // returns a global-safe wrapper. The same impl backs the connect()
    // exchange here and the cookie-session resource calls via BrowserHttpClient.
    this.fetchImpl = resolveBrowserFetch(opts.fetch);
    if (!opts.dpUrl) {
      throw new Error("IntrospectionApiClient requires a dpUrl");
    }
    const http = new BrowserHttpClient({
      apiUrl: opts.dpUrl,
      additionalHeaders: opts.additionalHeaders,
      fetch: this.fetchImpl,
      onUnauthorized: () => this.reexchange(),
    });
    this.cookieClients = {
      tasks: new TasksClient(http, { developmentLink: opts.developmentLink }),
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
   * Mint a token via `getToken` and redeem it at the DP for the
   * `intro_dp_session` cookie. Call once before issuing task requests.
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
  }

  /** 401 recovery: re-exchange, reporting success so the call can retry. */
  private async reexchange(): Promise<boolean> {
    try {
      await this.exchange();
      return true;
    } catch {
      return false;
    }
  }
}
