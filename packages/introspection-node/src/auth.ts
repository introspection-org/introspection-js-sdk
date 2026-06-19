/**
 * Service-account (machine) authentication for the Control Plane.
 *
 * Mints a short-lived, project-scoped Introspection access token via the
 * OAuth 2.0 `client_credentials` grant against CP `POST /v1/oauth/token`.
 * This is the headless / CI counterpart to a long-lived API key: the
 * confidential Application's `client_id` + `client_secret` stay server-side,
 * and you re-mint when the token expires (no refresh token is issued).
 *
 * The minted `access_token` is an ordinary CP bearer token, so it drops
 * straight into the existing client surface — pass it to
 * {@link IntrospectionClient}, or use
 * {@link IntrospectionClient.fromServiceAccount} to mint and construct in one
 * call, and the usual `client.runtimes("name").run()` flow works unchanged.
 */
import { stripTrailingSlash, toApiError } from "@introspection-sdk/http";

const DEFAULT_BASE_API_URL = "https://api.introspection.dev";
const GRANT_TYPE_CLIENT_CREDENTIALS = "client_credentials";

export interface ServiceAccountTokenParams {
  /** Confidential Application client id (`intro_app_…`). */
  clientId: string;
  /** Confidential Application client secret (`intro_sk_…`). */
  clientSecret: string;
  /**
   * Project the token is scoped to. Required by the CP `client_credentials`
   * grant — the minted token is project-scoped and the project must belong to
   * the Application's organization.
   */
  projectId: string;
  /**
   * Optional space-separated scope. Capped server-side to the Application's
   * `allowed_scopes`; omit to receive the Application's default scope.
   */
  scope?: string;
  /**
   * CP API base URL. Defaults to `INTROSPECTION_BASE_API_URL` or
   * `https://api.introspection.dev`.
   */
  baseApiUrl?: string;
  /** Custom `fetch` (for tests or non-standard runtimes). */
  fetch?: typeof fetch;
}

/**
 * CP `POST /v1/oauth/token` response for the `client_credentials` grant.
 * No refresh token is issued — re-mint with the secret when it expires.
 */
export interface ServiceAccountToken {
  /** Project-scoped RS256 CP access token (`Authorization: Bearer …`). */
  access_token: string;
  /** Always `"Bearer"`. */
  token_type: string;
  /** Token lifetime in seconds. */
  expires_in: number;
  /** The granted (scope-capped) scope, when the CP returns one. */
  scope: string | null;
}

/**
 * Mint a project-scoped CP access token from confidential service-account
 * credentials. See {@link ServiceAccountTokenParams}.
 *
 * @example
 * ```typescript
 * const { access_token } = await serviceAccountToken({
 *   clientId: process.env.INTROSPECTION_SERVICE_ACCOUNT_CLIENT_ID!,
 *   clientSecret: process.env.INTROSPECTION_SERVICE_ACCOUNT_CLIENT_SECRET!,
 *   projectId: process.env.INTRO_PROJECT_ID!,
 * });
 * const client = new IntrospectionClient({ token: access_token });
 * ```
 */
export async function serviceAccountToken(
  params: ServiceAccountTokenParams,
): Promise<ServiceAccountToken> {
  const baseApiUrl = stripTrailingSlash(
    params.baseApiUrl ??
      process.env.INTROSPECTION_BASE_API_URL ??
      DEFAULT_BASE_API_URL,
  );
  const fetchImpl = params.fetch ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error(
      "global fetch is unavailable; pass `fetch` or run on Node 18+",
    );
  }

  const form = new URLSearchParams({
    grant_type: GRANT_TYPE_CLIENT_CREDENTIALS,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    project_id: params.projectId,
  });
  if (params.scope) form.set("scope", params.scope);

  const res = await fetchImpl(`${baseApiUrl}/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    cache: "no-store",
  });
  if (!res.ok) throw await toApiError(res);

  return (await res.json()) as ServiceAccountToken;
}
