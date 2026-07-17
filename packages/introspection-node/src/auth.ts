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
 * call, and the usual `client.runtime("runtime-slug").run()` flow works unchanged.
 */
import { stripTrailingSlash, toApiError } from "@introspection-sdk/http";

const DEFAULT_BASE_API_URL = "https://api.introspection.dev";
const GRANT_TYPE_CLIENT_CREDENTIALS = "client_credentials";
const GRANT_TYPE_TOKEN_EXCHANGE =
  "urn:ietf:params:oauth:grant-type:token-exchange";
const GRANT_TYPE_AUTHORIZATION_CODE = "authorization_code";
const SUBJECT_TOKEN_TYPE_ID_TOKEN = "urn:ietf:params:oauth:token-type:id_token";

function resolveBaseApiUrl(baseApiUrl?: string): string {
  return stripTrailingSlash(
    baseApiUrl ??
      process.env.INTROSPECTION_BASE_API_URL ??
      DEFAULT_BASE_API_URL,
  );
}

function resolveFetch(custom?: typeof fetch): typeof fetch {
  const fetchImpl = custom ?? globalThis.fetch;
  if (!fetchImpl) {
    throw new Error(
      "global fetch is unavailable; pass `fetch` or run on Node 18+",
    );
  }
  return fetchImpl;
}

async function postTokenForm(
  baseApiUrl: string,
  form: URLSearchParams,
  fetchImpl: typeof fetch,
): Promise<OAuthToken> {
  const res = await fetchImpl(`${baseApiUrl}/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
    cache: "no-store",
  });
  if (!res.ok) throw await toApiError(res);
  return (await res.json()) as OAuthToken;
}

/**
 * CP `POST /v1/oauth/token` response. No refresh token is issued for the
 * machine grants — re-mint when it expires.
 */
export interface OAuthToken {
  /** Project-scoped RS256 access token (`Authorization: Bearer …`). */
  access_token: string;
  /** Always `"Bearer"`. */
  token_type: string;
  /** Token lifetime in seconds. */
  expires_in: number;
  /** The granted (scope-capped) scope, when the CP returns one. */
  scope: string | null;
  /**
   * Data Plane API base URL for the token's project, resolved by the CP the
   * same way it is for the CLI login. `null` when the deployment can't be
   * resolved; the caller then needs an explicit DP URL. Hand this to the
   * browser SDK as `dpUrl` so the SPA connects without separate DP config.
   */
  dp_url: string | null;
}

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
  project: string;
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
 * Back-compat alias: the `client_credentials` response is the same shape as
 * every other `/v1/oauth/token` response.
 */
export type ServiceAccountToken = OAuthToken;

/**
 * Mint a project-scoped CP access token from confidential service-account
 * credentials. See {@link ServiceAccountTokenParams}.
 *
 * @example
 * ```typescript
 * const { access_token, dp_url } = await serviceAccountToken({
 *   clientId: process.env.INTROSPECTION_SERVICE_ACCOUNT_CLIENT_ID!,
 *   clientSecret: process.env.INTROSPECTION_SERVICE_ACCOUNT_CLIENT_SECRET!,
 *   project: process.env.INTRO_PROJECT!,
 * });
 * const client = new IntrospectionClient({ token: access_token });
 * ```
 */
export async function serviceAccountToken(
  params: ServiceAccountTokenParams,
): Promise<OAuthToken> {
  const form = new URLSearchParams({
    grant_type: GRANT_TYPE_CLIENT_CREDENTIALS,
    client_id: params.clientId,
    client_secret: params.clientSecret,
    project: params.project,
  });
  if (params.scope) form.set("scope", params.scope);
  return postTokenForm(
    resolveBaseApiUrl(params.baseApiUrl),
    form,
    resolveFetch(params.fetch),
  );
}

export interface AuthorizationCodeParams {
  /** The authorization code returned to the redirect URI. */
  code: string;
  /** Public SPA Application `client_id` (PKCE — no secret). */
  clientId: string;
  /** The redirect URI the code was issued for (must match the authorize call). */
  redirectUri: string;
  /** The PKCE `code_verifier` paired with the authorize-step challenge. */
  codeVerifier: string;
  /**
   * CP API base URL. Defaults to `INTROSPECTION_BASE_API_URL` or
   * `https://api.introspection.dev`.
   */
  baseApiUrl?: string;
  /** Custom `fetch` (for tests or non-standard runtimes). */
  fetch?: typeof fetch;
}

/**
 * RFC 6749 / PKCE `authorization_code` exchange against CP
 * `POST /v1/oauth/token`. Run it in your backend so the browser hosted-login
 * flow does not hand-roll the token POST.
 */
export async function authorizationCodeToken(
  params: AuthorizationCodeParams,
): Promise<OAuthToken> {
  const form = new URLSearchParams({
    grant_type: GRANT_TYPE_AUTHORIZATION_CODE,
    code: params.code,
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });
  return postTokenForm(
    resolveBaseApiUrl(params.baseApiUrl),
    form,
    resolveFetch(params.fetch),
  );
}

export interface TokenExchangeParams {
  /** The end user's subject token (e.g. a partner-IdP `id_token`). */
  subjectToken: string;
  /** The federated Application's `client_id` (public client — no secret). */
  clientId: string;
  /** Project the minted DP token is scoped to. */
  project: string;
  /**
   * The subject token's type URI. Defaults to
   * `urn:ietf:params:oauth:token-type:id_token`.
   */
  subjectTokenType?: string;
  /** Optional space-separated scope, capped server-side. */
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
 * RFC 8693 token-exchange against CP `POST /v1/oauth/token`: trade an end
 * user's partner-IdP token for a project-scoped DP access token for a
 * `member_type=customer` member. Intended to run server-side in a broker (the
 * subject token shouldn't be re-handled in the browser longer than needed).
 *
 * @example
 * ```typescript
 * const { access_token, dp_url } = await tokenExchange({
 *   subjectToken: idTokenFromPartnerIdp,
 *   clientId: process.env.FEDERATED_CLIENT_ID!,
 *   project: process.env.INTRO_PROJECT!,
 * });
 * ```
 */
export async function tokenExchange(
  params: TokenExchangeParams,
): Promise<OAuthToken> {
  const form = new URLSearchParams({
    grant_type: GRANT_TYPE_TOKEN_EXCHANGE,
    subject_token: params.subjectToken,
    subject_token_type: params.subjectTokenType ?? SUBJECT_TOKEN_TYPE_ID_TOKEN,
    client_id: params.clientId,
    project: params.project,
  });
  if (params.scope) form.set("scope", params.scope);
  return postTokenForm(
    resolveBaseApiUrl(params.baseApiUrl),
    form,
    resolveFetch(params.fetch),
  );
}
