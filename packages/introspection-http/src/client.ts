import { NetworkError } from "@introspection-sdk/types";
import { buildQuery, joinUrl } from "./url.js";
import { toApiError } from "./errors.js";

/**
 * The one thing that differs between the Node and browser transports:
 * how a request proves who it is.
 *
 * - Node authenticates every request with an `Authorization: Bearer`
 *   header and sends no credentials.
 * - The browser sends no auth header and instead opts into
 *   `credentials: "include"` so the HttpOnly `intro_dp_session` cookie
 *   rides along, plus an `onUnauthorized` hook to re-mint that cookie on
 *   a 401.
 *
 * Everything else — URL joining, query building, body serialization,
 * error mapping, the `expect` decoder — is identical and lives in
 * {@link BaseHttpClient}.
 */
export interface Transport {
  /** Auth headers merged ahead of `additionalHeaders` on every request. */
  authHeaders(): Record<string, string>;
  /** `RequestInit.credentials` to attach (e.g. `"include"` for cookies). */
  credentials?: RequestCredentials;
  /**
   * Invoked when a request comes back `401`. Return `true` if the
   * credential was refreshed and the request should be retried once;
   * `false` to surface the original error. Omit for transports (like the
   * bearer-token Node client) that don't refresh in-band.
   */
  onUnauthorized?(): Promise<boolean>;
}

export interface BaseHttpConfig {
  /** Base URL every request path is prefixed with. */
  apiUrl: string;
  /** Auth strategy: bearer header vs cookie + re-exchange. */
  transport: Transport;
  /** Extra headers merged into every request. */
  additionalHeaders?: Record<string, string>;
  /** Custom `fetch` (for tests or non-standard runtimes). */
  fetch?: typeof fetch;
}

/**
 * Isomorphic HTTP wrapper for the Introspection `/v1` surface. Carries no
 * opinion about which resource it serves or how it authenticates — the
 * caller supplies the base URL via config and the auth via {@link Transport}.
 */
export class BaseHttpClient {
  protected readonly fetchImpl: typeof fetch;

  constructor(protected readonly cfg: BaseHttpConfig) {
    this.fetchImpl = cfg.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error(
        "global fetch is unavailable; pass `fetch` or run on Node 18+ / a modern browser",
      );
    }
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      ...this.cfg.transport.authHeaders(),
      ...(this.cfg.additionalHeaders ?? {}),
      ...(extra ?? {}),
    };
  }

  private async attempt(doFetch: () => Promise<Response>): Promise<Response> {
    try {
      return await doFetch();
    } catch (err) {
      throw new NetworkError({
        message: err instanceof Error ? err.message : "network request failed",
        code: null,
        requestId: null,
        body: err,
      });
    }
  }

  /**
   * Run `doFetch`, refreshing + retrying once on a 401 when the transport
   * supplies an `onUnauthorized` handler, then map any non-ok response to
   * a typed {@link IntrospectionAPIError}.
   */
  private async send(doFetch: () => Promise<Response>): Promise<Response> {
    let res = await this.attempt(doFetch);
    const { onUnauthorized } = this.cfg.transport;
    if (res.status === 401 && onUnauthorized) {
      const refreshed = await onUnauthorized();
      if (refreshed) res = await this.attempt(doFetch);
    }
    if (!res.ok) throw await toApiError(res);
    return res;
  }

  async request<T>(opts: {
    method: string;
    path: string;
    query?: Record<string, unknown>;
    body?: unknown;
    headers?: Record<string, string>;
    expect?: "json" | "empty" | "bytes" | "stream";
    signal?: AbortSignal;
  }): Promise<T> {
    const url = joinUrl(this.cfg.apiUrl, opts.path) + buildQuery(opts.query);
    let body: BodyInit | undefined;
    const headers = this.headers(opts.headers);
    if (opts.body instanceof FormData) {
      body = opts.body;
      // let fetch set the multipart boundary
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
      body = JSON.stringify(opts.body);
    }
    const res = await this.send(() =>
      this.fetchImpl(url, {
        method: opts.method,
        headers,
        body,
        credentials: this.cfg.transport.credentials,
        signal: opts.signal,
      }),
    );
    const expect = opts.expect ?? "json";
    if (expect === "empty") return undefined as T;
    if (expect === "bytes") return new Uint8Array(await res.arrayBuffer()) as T;
    if (expect === "stream") return res.body as T;
    return (await res.json()) as T;
  }

  async stream(opts: {
    path: string;
    query?: Record<string, unknown>;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  }): Promise<Response> {
    const url = joinUrl(this.cfg.apiUrl, opts.path) + buildQuery(opts.query);
    return this.send(() =>
      this.fetchImpl(url, {
        method: "GET",
        headers: this.headers({
          Accept: "text/event-stream",
          ...(opts.headers ?? {}),
        }),
        credentials: this.cfg.transport.credentials,
        signal: opts.signal,
      }),
    );
  }
}
