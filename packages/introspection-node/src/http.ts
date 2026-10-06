import { BaseHttpClient } from "@introspection-sdk/http";

/**
 * A bearer credential that renews itself: a signed-in member's session (see
 * {@link AuthClient}), as opposed to a fixed API key or runner token.
 */
export interface BearerCredentials {
  /** The access token to send now, refreshed first if it is about to expire. */
  accessToken(): Promise<string | null>;
  /**
   * A request carrying `rejected` came back `401`. Renew the credential and
   * return `true` to retry once, or `false` to surface the `401`.
   */
  refreshAfterUnauthorized(rejected: string | null): Promise<boolean>;
}

export interface ResolvedApiConfig {
  /**
   * Base URL the client will prepend to every request path. For the
   * IntrospectionClient this is the CP API host; for a Runner it is the
   * `deployment.endpoint` returned by CP.
   */
  apiUrl: string;
  /** Bearer token. Customer API key for CP, runner JWT for DP. */
  token: string;
  /**
   * A renewing credential used instead of {@link token}: read before every
   * request, and asked to refresh after a `401`.
   */
  credentials?: BearerCredentials;
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

const BEARER_PREFIX = "Bearer ";

/**
 * Authenticated HTTP client used by the CP-bound IntrospectionClient and each
 * DP-bound Runner. A member-authored Node workflow may supply the encoded
 * `intro_cp_session` for CP-only operations; all other calls use bearer auth.
 */
export class HttpClient extends BaseHttpClient {
  constructor(cfg: ResolvedApiConfig) {
    const { credentials } = cfg;
    super({
      apiUrl: cfg.apiUrl,
      additionalHeaders: cfg.additionalHeaders,
      fetch: cfg.fetch,
      maxRetries: cfg.maxRetries,
      retryBaseMs: cfg.retryBaseMs,
      transport: credentials
        ? {
            authHeaders: async (): Promise<Record<string, string>> => {
              const token = await credentials.accessToken();
              return token ? { Authorization: `${BEARER_PREFIX}${token}` } : {};
            },
            onUnauthorized: (rejected) => {
              const header = rejected.Authorization;
              return credentials.refreshAfterUnauthorized(
                header?.startsWith(BEARER_PREFIX)
                  ? header.slice(BEARER_PREFIX.length)
                  : null,
              );
            },
          }
        : {
            authHeaders: (): Record<string, string> => {
              if (cfg.cpSession) {
                return { Cookie: `intro_cp_session=${cfg.cpSession}` };
              }
              return { Authorization: `${BEARER_PREFIX}${cfg.token}` };
            },
          },
    });
  }
}
