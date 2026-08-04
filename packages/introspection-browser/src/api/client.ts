/**
 * Browser-side Introspection API client.
 *
 * Lets a single-page app create and stream Introspection tasks directly
 * from the browser, with no API key in JavaScript. The browser talks only
 * to the Data Plane — runtime resolution and any other Control Plane work
 * stays on the app's backend, so the CP never needs to serve CORS to
 * customer web origins. The auth boundary:
 *
 *   1. The SPA's own backend ("broker") holds the Introspection Node SDK
 *      `Runner` and serializes it into a {@link BrowserSessionBootstrap}
 *      via `runner.browserSession()` (or, in the legacy `getToken` shape,
 *      mints a bare short-lived access token). The SPA fetches it through
 *      the `getSession` / `getToken` callback.
 *   2. `connect()` redeems the bootstrap's `session_token` at the DP
 *      `POST /v1/oauth/exchange` for the HttpOnly `intro_dp_session`
 *      cookie, bound to the bootstrap's `deployment.endpoint`.
 *   3. Every subsequent call rides that cookie (`credentials: "include"`)
 *      plus an `X-Expected-Identity` header pinning the identity the
 *      session was brokered for — `client.tasks.start(...)`, `.get(...)`,
 *      run streaming, etc.
 *
 * The client owns the session lifecycle: concurrent connects/re-exchanges
 * are collapsed into one in-flight promise; a `tasks.create()` against an
 * expired or invalidated bootstrap re-brokers first; a 401 mid-request
 * (expired cookie or `identity_binding_mismatch`) triggers exactly ONE
 * re-broker + re-exchange + retry — never a loop; a 404 is a plain
 * not-found and never touches the session.
 */

import type { BrowserSessionBootstrap } from "@introspection-sdk/types";
import { identityKey } from "@introspection-sdk/types";
import { BrowserHttpClient, stripTrailingSlash, toApiError } from "./http.js";
import { resolveBrowserFetch } from "./fetch.js";
import {
  ConversationsClient,
  FilesClient,
  SharesClient,
  type ResourceHttpClient,
} from "@introspection-sdk/http";
import { TasksClient } from "./tasks.js";

type CookieClients = {
  tasks: TasksClient;
  files: FilesClient;
  conversations: ConversationsClient;
  shares: SharesClient;
};

/**
 * Treat the bootstrap as expired this long before its `expires_at` so a
 * create that would land right at the boundary re-brokers instead of
 * racing the server-side expiry.
 */
const EXPIRY_SKEW_MS = 30_000;

export interface IntrospectionApiClientOptions {
  /**
   * Data Plane REST base URL for the cookie-session APIs. Required in the
   * legacy `getToken` shape; ignored when `getSession` is provided (the
   * bootstrap carries its own `deployment.endpoint`).
   */
  dpUrl?: string;
  /**
   * Legacy broker shape: returns a fresh Introspection access token from
   * the app's backend, exchanged at `dpUrl`. Superseded by `getSession`
   * when both are provided.
   */
  getToken?: () => string | Promise<string>;
  /**
   * Returns a fresh {@link BrowserSessionBootstrap} from the app's backend
   * (the Node SDK's `runner.browserSession()`). Called on `connect()`, when
   * a `tasks.create()` finds the bootstrap expired/invalidated, and when a
   * request 401s. When provided the client manages the full session
   * lifecycle (endpoint binding, `X-Expected-Identity`, expiry-aware
   * re-brokering) and `dpUrl`/`getToken` are not used.
   */
  getSession?: () => Promise<BrowserSessionBootstrap>;
  /** Custom `fetch` (for tests or non-standard runtimes). */
  fetch?: typeof fetch;
  /** Extra headers merged into every DP request. */
  additionalHeaders?: Record<string, string>;
}

export class IntrospectionApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly cookieClients: CookieClients;

  /** Transport bound to the current DP endpoint (null until first exchange in `getSession` mode). */
  private http: BrowserHttpClient | null = null;
  /** Endpoint the transport is bound to (sans trailing slash). */
  private endpoint: string | null = null;
  /** Identity key of the current bootstrap, sent as `X-Expected-Identity`. */
  private expectedIdentity: string | null = null;
  /** `expires_at` of the current bootstrap (ms epoch; 0 = none yet). */
  private expiresAtMs = 0;
  /** Set when the session must be re-brokered before the next create. */
  private invalidated = false;
  /** Single in-flight broker+exchange shared by concurrent callers. */
  private inflightExchange: Promise<void> | null = null;
  private visibilityListener: (() => void) | null = null;

  constructor(private readonly opts: IntrospectionApiClientOptions) {
    // Native browser `fetch` throws "Illegal invocation" when called as a
    // method of this client (`this.fetchImpl(...)`); resolveBrowserFetch
    // returns a global-safe wrapper. The same impl backs the connect()
    // exchange here and the cookie-session resource calls via BrowserHttpClient.
    this.fetchImpl = resolveBrowserFetch(opts.fetch);
    if (!opts.getSession && !opts.dpUrl) {
      throw new Error("IntrospectionApiClient requires a dpUrl");
    }
    if (!opts.getSession && !opts.getToken) {
      throw new Error("IntrospectionApiClient requires getSession or getToken");
    }
    if (!opts.getSession) {
      // Legacy shape: the endpoint is known up front, bind immediately.
      this.bindTransport(stripTrailingSlash(opts.dpUrl!));
    }
    // Resource clients are built ONCE over a delegating facade; the facade
    // always routes to the transport bound to the CURRENT endpoint, so a
    // held `client.tasks` reference survives an endpoint-change rebuild.
    const facade: ResourceHttpClient = {
      request: async (o) => (await this.transport()).request(o),
      stream: async (o) => (await this.transport()).stream(o),
    };
    this.cookieClients = {
      tasks: new TasksClient(facade, () => this.ensureFreshForCreate()),
      files: new FilesClient(facade),
      conversations: new ConversationsClient(facade),
      shares: new SharesClient(facade),
    };
    if (opts.getSession && typeof document !== "undefined") {
      // On tab wake, mark an already-expired session as needing
      // revalidation so the next create re-brokers instead of failing.
      this.visibilityListener = () => {
        if (document.visibilityState === "visible" && this.isExpired()) {
          this.invalidated = true;
        }
      };
      document.addEventListener("visibilitychange", this.visibilityListener);
    }
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
   * Broker a session (via `getSession` / `getToken`) and redeem it at the
   * DP for the `intro_dp_session` cookie. Concurrent calls share one
   * in-flight exchange. Optional in `getSession` mode — the first request
   * connects on demand — but calling it up front surfaces broker errors
   * early.
   */
  async connect(): Promise<void> {
    await this.exchangeOnce();
  }

  /**
   * Detach the `visibilitychange` wake listener. Call when the app is done
   * with the client (e.g. React effect cleanup). Does not revoke the
   * server-side session cookie.
   */
  dispose(): void {
    if (this.visibilityListener && typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.visibilityListener);
    }
    this.visibilityListener = null;
  }

  // --- session lifecycle internals ---

  private isExpired(): boolean {
    return (
      this.expiresAtMs !== 0 && Date.now() >= this.expiresAtMs - EXPIRY_SKEW_MS
    );
  }

  /**
   * Transport for the current endpoint. In `getSession` mode the first
   * call brokers + exchanges on demand (connect-on-first-use).
   */
  private async transport(): Promise<BrowserHttpClient> {
    if (!this.http) await this.exchangeOnce();
    return this.http!;
  }

  /**
   * Pre-create freshness gate (threaded into `tasks.create` /
   * `tasks.runs.create`): re-broker + re-exchange when the bootstrap is
   * past `expires_at` (with skew), was invalidated by a tab wake, or was
   * never exchanged at all. No-op in the legacy `getToken` shape, which
   * relies solely on the 401 path.
   */
  private async ensureFreshForCreate(): Promise<void> {
    if (!this.opts.getSession) return;
    if (!this.http || this.invalidated || this.isExpired()) {
      await this.exchangeOnce();
    }
  }

  /** Serialize + dedupe: one broker+exchange at a time, shared by all callers. */
  private exchangeOnce(): Promise<void> {
    if (!this.inflightExchange) {
      this.inflightExchange = this.exchange().finally(() => {
        this.inflightExchange = null;
      });
    }
    return this.inflightExchange;
  }

  private async exchange(): Promise<void> {
    if (this.opts.getSession) {
      const bootstrap = await this.opts.getSession();
      const endpoint = stripTrailingSlash(bootstrap.deployment.endpoint);
      if (endpoint !== this.endpoint) {
        // Fresh bootstrap moved deployments — rebind the transport so
        // every subsequent request targets the new endpoint.
        this.bindTransport(endpoint);
      }
      await this.postExchange(endpoint, bootstrap.session_token);
      this.expectedIdentity = identityKey(bootstrap.runtime_context.identity);
      this.expiresAtMs = Date.parse(bootstrap.expires_at) || 0;
      this.invalidated = false;
      return;
    }
    const token = await this.opts.getToken!();
    await this.postExchange(stripTrailingSlash(this.opts.dpUrl!), token);
  }

  private async postExchange(endpoint: string, token: string): Promise<void> {
    const res = await this.fetchImpl(`${endpoint}/v1/oauth/exchange`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.opts.additionalHeaders ?? {}),
      },
      body: JSON.stringify({ token }),
      credentials: "include",
    });
    if (!res.ok) throw await toApiError(res);
  }

  /** Build the cookie transport bound to `endpoint`. */
  private bindTransport(endpoint: string): void {
    this.endpoint = endpoint;
    this.http = new BrowserHttpClient({
      apiUrl: endpoint,
      additionalHeaders: this.opts.additionalHeaders,
      fetch: this.fetchImpl,
      // After an exchange, pin every request to the identity the session
      // was brokered for. Resolved per attempt, so the post-401 retry
      // carries the refreshed identity.
      defaultHeaders: (): Record<string, string> =>
        this.expectedIdentity
          ? { "X-Expected-Identity": this.expectedIdentity }
          : {},
      // 401 recovery — expired cookie or `identity_binding_mismatch`:
      // one re-broker + re-exchange, then the transport retries the
      // request exactly once (same `Idempotency-Key`). Never loops; any
      // other status (404 included) is surfaced untouched.
      onUnauthorized: () => this.reexchange(),
    });
  }

  /** 401 recovery: re-broker + re-exchange, reporting success so the call can retry. */
  private async reexchange(): Promise<boolean> {
    try {
      await this.exchangeOnce();
      return true;
    } catch {
      return false;
    }
  }
}
