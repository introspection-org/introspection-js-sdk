/**
 * Browser-side Introspection API client.
 *
 * Lets a single-page app create and stream Introspection tasks directly
 * from the browser, with no API key in JavaScript. The auth boundary:
 *
 *   1. The SPA's own backend ("broker") mints an Introspection access
 *      token — via RFC 8693 token-exchange of the partner IdP token, a
 *      PKCE `authorization_code`, or `client_credentials`. The IdP
 *      secret never leaves the backend. The SPA fetches that token
 *      through the `getToken` callback.
 *   2. `connect()` redeems the token at the DP `POST /v1/oauth/exchange`
 *      for the HttpOnly `intro_dp_session` cookie.
 *   3. Every subsequent call rides that cookie (`credentials: "include"`)
 *      — `client.tasks.start(...)`, `.get(...)`, run streaming, etc.
 *
 * When the session cookie expires, an in-flight request gets a 401, and
 * the client transparently re-runs `getToken` + the DP exchange once
 * before retrying.
 */

import {
  BrowserBearerHttpClient,
  BrowserHttpClient,
  stripTrailingSlash,
  toApiError,
} from "./http.js";
import {
  ConversationsClient,
  FilesClient,
  SharesClient,
} from "@introspection-sdk/http";
import { TasksClient } from "./tasks.js";
import {
  attachBrowserRuntimes,
  type BrowserRuntimeHandleFactory,
  type BrowserRuntimesClient,
} from "./runtimes.js";
import type { BrowserRunnerSource } from "./runner.js";
import type { RunnerSpec } from "@introspection-sdk/types";

type CookieClients = {
  tasks: TasksClient;
  files: FilesClient;
  conversations: ConversationsClient;
  shares: SharesClient;
};

export interface IntrospectionApiClientOptions {
  /**
   * Control Plane REST base URL. Used by `client.runtimes(name).run()` to
   * resolve runtimes and mint runner specs. Defaults to
   * `https://api.introspection.dev`.
   */
  cpUrl?: string;
  /**
   * Data Plane REST base URL for the cookie-session APIs (`connect()` and
   * top-level `client.tasks` / `client.files` / `client.conversations` /
   * `client.shares`). Runner APIs use the DP endpoint returned by CP and do
   * not require this option.
   */
  dpUrl?: string;
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
}

export class IntrospectionApiClient {
  /**
   * CRUD on CP `/v1/runtimes` and the `(idOrName) => RuntimeHandle` factory.
   * Call as `client.runtimes("customer-agent").run()`.
   */
  readonly runtimes: BrowserRuntimesClient & BrowserRuntimeHandleFactory;

  private readonly fetchImpl: typeof fetch;
  private readonly cpHttp: BrowserBearerHttpClient;
  private readonly cookieClients: CookieClients | null;

  constructor(private readonly opts: IntrospectionApiClientOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error(
        "global fetch is unavailable; pass `fetch` or run in a modern browser",
      );
    }
    this.cpHttp = new BrowserBearerHttpClient({
      apiUrl: opts.cpUrl ?? "https://api.introspection.dev",
      token: opts.getToken,
      additionalHeaders: opts.additionalHeaders,
      fetch: opts.fetch,
    });
    this.runtimes = attachBrowserRuntimes(this.cpHttp, {
      additionalHeaders: opts.additionalHeaders,
      fetch: opts.fetch,
      requestFreshRunnerSpec: (source) => this.requestFreshRunnerSpec(source),
    });
    if (opts.dpUrl) {
      const http = new BrowserHttpClient({
        apiUrl: opts.dpUrl,
        additionalHeaders: opts.additionalHeaders,
        fetch: opts.fetch,
        onUnauthorized: () => this.reexchange(),
      });
      this.cookieClients = {
        tasks: new TasksClient(http),
        files: new FilesClient(http),
        conversations: new ConversationsClient(http),
        shares: new SharesClient(http),
      };
    } else {
      this.cookieClients = null;
    }
  }

  /** `/v1/tasks` operations bound to the DP session cookie. */
  get tasks(): TasksClient {
    return this.requireCookieClient("tasks");
  }

  /** `/v1/files` operations bound to the DP session cookie. */
  get files(): FilesClient {
    return this.requireCookieClient("files");
  }

  /** Read-only `/v1/conversations` projection bound to the session cookie. */
  get conversations(): ConversationsClient {
    return this.requireCookieClient("conversations");
  }

  /** `/v1/shares` read-sharing grants bound to the session cookie. */
  get shares(): SharesClient {
    return this.requireCookieClient("shares");
  }

  /**
   * Mint a token via `getToken` and redeem it at the DP for the
   * `intro_dp_session` cookie. Call once before issuing task requests.
   */
  async connect(): Promise<void> {
    this.requireDpUrl();
    await this.exchange();
  }

  private async exchange(): Promise<void> {
    const dpUrl = this.requireDpUrl();
    const token = await this.opts.getToken();
    const res = await this.fetchImpl(
      `${stripTrailingSlash(dpUrl)}/v1/oauth/exchange`,
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

  private requireCookieClient<K extends keyof CookieClients>(
    key: K,
  ): CookieClients[K] {
    if (!this.cookieClients) {
      throw new Error(
        `IntrospectionApiClient.${key} requires dpUrl; use client.runtimes(...).run() for runner-bound APIs or pass dpUrl for cookie-session APIs`,
      );
    }
    return this.cookieClients[key];
  }

  private requireDpUrl(): string {
    if (!this.opts.dpUrl) {
      throw new Error(
        "IntrospectionApiClient.connect() requires dpUrl; use client.runtimes(...).run() for runner-bound APIs or pass dpUrl for cookie-session APIs",
      );
    }
    return this.opts.dpUrl;
  }

  private async requestFreshRunnerSpec(
    source: BrowserRunnerSource,
  ): Promise<RunnerSpec> {
    if (source.kind === "runtime") {
      return this.cpHttp.request<RunnerSpec>({
        method: "POST",
        path: `/v1/runtimes/${encodeURIComponent(source.id)}/run`,
        body: source.options ?? {},
      });
    }
    return this.cpHttp.request<RunnerSpec>({
      method: "POST",
      path: `/v1/experiments/${encodeURIComponent(source.id)}/run`,
      body: source.options ?? {},
    });
  }
}
