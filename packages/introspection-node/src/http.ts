import {
  IntrospectionAPIError,
  NetworkError,
  apiErrorFromResponse,
} from "@introspection-sdk/types";

export interface ResolvedApiConfig {
  /**
   * Base URL the client will prepend to every request path. For the
   * IntrospectionClient this is the CP API host; for a Runner it is the
   * `deployment.endpoint` returned by CP.
   */
  apiUrl: string;
  /** Bearer token. Customer API key for CP, runner JWT for DP. */
  token: string;
  additionalHeaders?: Record<string, string>;
  fetch?: typeof fetch;
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
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
 * Thin HTTP wrapper used by both the CP-bound IntrospectionClient and
 * each DP-bound Runner. Has no opinion on which one it is — the caller
 * picks the base URL and the token.
 */
export class HttpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: ResolvedApiConfig) {
    this.fetchImpl = cfg.fetch ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new Error(
        "global fetch is unavailable; pass `advanced.fetch` or run on Node 18+",
      );
    }
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.token}`,
      ...(this.cfg.additionalHeaders ?? {}),
      ...(extra ?? {}),
    };
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
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: opts.method,
        headers,
        body,
      });
    } catch (err) {
      throw new NetworkError({
        message: err instanceof Error ? err.message : "network request failed",
        code: null,
        requestId: null,
        body: err,
      });
    }
    if (!res.ok) throw await toApiError(res);
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
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: this.headers({ Accept: "text/event-stream" }),
      });
    } catch (err) {
      throw new NetworkError({
        message: err instanceof Error ? err.message : "network request failed",
        code: null,
        requestId: null,
        body: err,
      });
    }
    if (!res.ok) throw await toApiError(res);
    return res;
  }
}

async function toApiError(res: Response): Promise<IntrospectionAPIError> {
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
