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
  /** Encoded member session used instead of bearer auth on Control Plane calls. */
  cpSession?: string;
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
 * Authenticated HTTP client used by the CP-bound IntrospectionClient and each
 * DP-bound Runner. A member-authored Node workflow may supply the encoded
 * `intro_cp_session` for CP-only operations; all other calls use bearer auth.
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
        authHeaders: (): Record<string, string> => {
          if (cfg.cpSession) {
            return { Cookie: `intro_cp_session=${cfg.cpSession}` };
          }
          return { Authorization: `Bearer ${cfg.token}` };
        },
      },
    });
  }
}
