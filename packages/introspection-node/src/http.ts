import { BaseHttpClient } from "@introspection-sdk/http";

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
  /**
   * Automatic retries on a `429 Too Many Requests` for unary requests
   * (honouring `Retry-After`). `0` disables. Defaults to the shared client
   * default. Streaming has its own resume budget.
   */
  maxRetries?: number;
  /** Base step (ms) of the capped-exponential `429` retry backoff. */
  retryBaseMs?: number;
}

/**
 * Bearer-token HTTP client used by both the CP-bound IntrospectionClient
 * and each DP-bound Runner. The request/response machinery lives in the
 * shared {@link BaseHttpClient}; this only pins the auth strategy —
 * `Authorization: Bearer <token>` on every request, no cookie credentials.
 */
export class HttpClient extends BaseHttpClient {
  constructor(cfg: ResolvedApiConfig) {
    super({
      apiUrl: cfg.apiUrl,
      additionalHeaders: cfg.additionalHeaders,
      fetch: cfg.fetch,
      maxRetries: cfg.maxRetries,
      retryBaseMs: cfg.retryBaseMs,
      transport: {
        authHeaders: () => ({ Authorization: `Bearer ${cfg.token}` }),
      },
    });
  }
}
