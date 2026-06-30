import {
  IntrospectionAPIError,
  NetworkError,
  RateLimitError,
} from "@introspection-sdk/types";
import { buildQuery, joinUrl } from "./url.js";
import { toApiError } from "./errors.js";

/** Statuses retried only for idempotent (GET) requests. */
const IDEMPOTENT_RETRY_STATUSES = new Set([502, 503, 504]);

/**
 * Whether a thrown error is worth retrying. `429` is retried for any method
 * (the request was rejected and never processed, so re-sending is safe even
 * for writes); transient gateway/upstream errors (`502`/`503`/`504`) are
 * retried only for idempotent `GET` requests.
 */
function isRetryableError(err: unknown, method: string): boolean {
  if (err instanceof RateLimitError) return true;
  if (err instanceof IntrospectionAPIError && method.toUpperCase() === "GET") {
    return IDEMPOTENT_RETRY_STATUSES.has(err.status);
  }
  return false;
}

/** Default automatic retries on a `429` for unary requests. */
const DEFAULT_MAX_RETRIES = 2;
/** Default base step (ms) of the capped-exponential `429` retry backoff. */
const DEFAULT_RETRY_BASE_MS = 500;
/** Cap on the `429` retry backoff (ms). */
const MAX_RETRY_BACKOFF_MS = 10000;

/** `Retry-After` (s) as the floor of a capped-exponential step (`base * 2^n`). */
function retryDelayMs(
  attempt: number,
  retryAfterSec: number | null,
  baseMs: number,
): number {
  const exp = Math.min(baseMs * 2 ** attempt, MAX_RETRY_BACKOFF_MS);
  return Math.max((retryAfterSec ?? 0) * 1000, exp);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

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
  /**
   * Automatic retries on a `429 Too Many Requests` for unary requests
   * (honouring `Retry-After`). `0` disables retrying. Default
   * {@link DEFAULT_MAX_RETRIES}. Streaming has its own resume budget.
   */
  maxRetries?: number;
  /** Base step (ms) of the capped-exponential `429` retry backoff. Default 500. */
  retryBaseMs?: number;
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
    const isMultipart = opts.body instanceof FormData;
    if (isMultipart) {
      body = opts.body as FormData;
      // let fetch set the multipart boundary
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = headers["Content-Type"] ?? "application/json";
      body = JSON.stringify(opts.body);
    }
    const expect = opts.expect ?? "json";
    // Auto-retry on a `429 Too Many Requests`, honouring `Retry-After` as the
    // floor of a capped-exponential backoff, so a spammed status poll slows
    // down instead of erroring. A `429` means the request was rejected and
    // never processed, so retrying is side-effect-safe for writes too.
    // Multipart uploads aren't retried (the body would have to be rebuilt).
    const maxRetries = isMultipart
      ? 0
      : (this.cfg.maxRetries ?? DEFAULT_MAX_RETRIES);
    const baseMs = this.cfg.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await this.send(() =>
          this.fetchImpl(url, {
            method: opts.method,
            headers,
            body,
            credentials: this.cfg.transport.credentials,
            signal: opts.signal,
          }),
        );
        if (expect === "empty") return undefined as T;
        if (expect === "bytes")
          return new Uint8Array(await res.arrayBuffer()) as T;
        if (expect === "stream") return res.body as T;
        return (await res.json()) as T;
      } catch (err) {
        if (
          isRetryableError(err, opts.method) &&
          attempt < maxRetries &&
          !opts.signal?.aborted
        ) {
          const retryAfter =
            err instanceof IntrospectionAPIError ? err.retryAfter : null;
          await sleep(retryDelayMs(attempt, retryAfter, baseMs), opts.signal);
          continue;
        }
        throw err;
      }
    }
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
