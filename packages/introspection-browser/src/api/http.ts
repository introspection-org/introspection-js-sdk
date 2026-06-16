/**
 * Browser HTTP transport for the Introspection Data Plane `/v1` surface.
 *
 * Unlike the Node SDK's `HttpClient` — which authenticates every request
 * with an `Authorization: Bearer <token>` header — the browser talks to
 * the DP with the HttpOnly `intro_dp_session` cookie minted by
 * `POST /v1/oauth/exchange`. So this client sends NO bearer token and
 * instead opts every request into `credentials: "include"`. No
 * Introspection credential ever lives in JavaScript.
 *
 * A 401 (expired session cookie) triggers a single `onUnauthorized`
 * refresh + retry, so callers don't have to thread re-exchange logic
 * through every call site.
 */

import {
  IntrospectionAPIError,
  NetworkError,
  apiErrorFromResponse,
} from "@introspection-sdk/types";

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

export function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function joinUrl(base: string, path: string): string {
  const b = stripTrailingSlash(base);
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

function buildQuery(params?: Record<string, unknown>): string {
  if (!params) return "";
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      for (const item of v) sp.append(k, String(item));
    } else {
      sp.set(k, String(v));
    }
  }
  const q = sp.toString();
  return q ? `?${q}` : "";
}

/**
 * Cookie-authenticated HTTP wrapper bound to one DP endpoint. Has no
 * opinion about which resource it serves — the caller picks the path.
 */
export class BrowserHttpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: BrowserHttpConfig) {
    this.fetchImpl = cfg.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error(
        "global fetch is unavailable; pass `fetch` or run in a modern browser",
      );
    }
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      ...(this.cfg.additionalHeaders ?? {}),
      ...(extra ?? {}),
    };
  }

  /**
   * Run `doFetch`, refreshing + retrying once on a 401 when an
   * `onUnauthorized` handler is configured, then map any non-ok response
   * to a typed {@link IntrospectionAPIError}.
   */
  private async send(doFetch: () => Promise<Response>): Promise<Response> {
    let res = await this.attempt(doFetch);
    if (res.status === 401 && this.cfg.onUnauthorized) {
      const refreshed = await this.cfg.onUnauthorized();
      if (refreshed) res = await this.attempt(doFetch);
    }
    if (!res.ok) throw await toApiError(res);
    return res;
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

  async request<T>(opts: {
    method: string;
    path: string;
    query?: Record<string, unknown>;
    body?: unknown;
    headers?: Record<string, string>;
    expect?: "json" | "empty" | "bytes" | "stream";
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
        credentials: "include",
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
  }): Promise<Response> {
    const url = joinUrl(this.cfg.apiUrl, opts.path) + buildQuery(opts.query);
    return this.send(() =>
      this.fetchImpl(url, {
        method: "GET",
        headers: this.headers({ Accept: "text/event-stream" }),
        credentials: "include",
      }),
    );
  }
}

export async function toApiError(
  res: Response,
): Promise<IntrospectionAPIError> {
  let body: unknown = undefined;
  let message = `HTTP ${res.status}`;
  let code: string | null = null;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("json")) {
    body = await res.json().catch(() => undefined);
    if (body && typeof body === "object") {
      const obj = body as Record<string, unknown>;
      if (typeof obj.detail === "string") message = obj.detail;
      if (typeof obj.code === "string") code = obj.code;
      if (typeof obj.message === "string" && message === `HTTP ${res.status}`) {
        message = obj.message;
      }
    }
  } else {
    body = await res.text().catch(() => undefined);
  }
  const retryAfterHeader = res.headers.get("retry-after");
  let retryAfter: number | null = null;
  if (retryAfterHeader) {
    const n = Number(retryAfterHeader);
    if (Number.isFinite(n)) retryAfter = n;
  }
  return apiErrorFromResponse({
    status: res.status,
    message,
    code,
    requestId: res.headers.get("x-request-id"),
    body,
    retryAfter,
  });
}
