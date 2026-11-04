/**
 * Flight Sector's discovery documents and its OAuth server (spec 3, 4):
 * Direct Sign-In (authorization code with PKCE), refresh tokens, revocation,
 * and `private_key_jwt` client authentication for clients named by their
 * metadata document. Sign-in is plain OAuth: the token endpoint never sees a
 * Session. Tokens are opaque; the records behind them live here.
 */
import "server-only";

import { jwtVerify } from "jose";

import { now, random, sha256 } from "../crypto";
import { once } from "../once";
import { COMPANY_URL } from "../origins";
import { type ClientMetadata, clientKeys, clientMetadata } from "./clients";
import { PoppyError } from "./errors";

/** One host is Flight Sector's domain, its issuer and its conversation API. */
export const DOMAIN = new URL(COMPANY_URL).hostname;
export const ISSUER = COMPANY_URL;
export const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;
export const AUTHORIZE_ENDPOINT = `${ISSUER}/oauth/authorize`;
export const REVOCATION_ENDPOINT = `${ISSUER}/oauth/revoke`;
export const CONVERSATIONS = `${COMPANY_URL}/poppy/conversations`;

/** Flight Sector's own scopes; the protocol defines none (spec 4.7). */
export const SCOPES = {
  "bookings:read":
    "See your bookings: flights, seats, fares and the email they go to.",
  "bookings:write":
    "Change your bookings, including fare differences charged to the card on the booking. Includes seeing them.",
};
export type Scope = keyof typeof SCOPES;
const SCOPE_HINTS = {
  "bookings:read": { changes: "none", personal_data: true },
  "bookings:write": { changes: "irreversible", personal_data: true },
};

const ACCESS_TOKEN_TTL = 15 * 60;
const REFRESH_TOKEN_TTL = 30 * 24 * 3600;
const CODE_TTL = 120;
const ASSERTION_ALGS = ["ES256", "PS384"];

/** Sam's account: the demo's only customer. */
export const ACCOUNT = {
  id: "acct_sam",
  name: "Sam Reyes",
  email: "sam@acme.example",
};

export function poppyDocument() {
  return {
    protocol_version: "0.3",
    organization: { name: "Flight Sector", domain: DOMAIN },
    auth: { issuer: ISSUER, scopes: SCOPES, scope_hints: SCOPE_HINTS },
    agent: {
      protocols: [
        { type: "poppy", endpoint: CONVERSATIONS, access: "session" },
      ],
    },
    extensions: { operations: { version: "2" } },
  };
}

/** The domain's protected resource metadata names its issuer (RFC 9728, spec 3.2). */
export function protectedResource() {
  return {
    resource: `https://${DOMAIN}`,
    authorization_servers: [ISSUER],
    bearer_methods_supported: ["header"],
    scopes_supported: Object.keys(SCOPES),
  };
}

/** RFC 8414 metadata; `protected_resources` vouches for the domain (spec 3.2). */
export function serverMetadata() {
  return {
    issuer: ISSUER,
    authorization_endpoint: AUTHORIZE_ENDPOINT,
    token_endpoint: TOKEN_ENDPOINT,
    revocation_endpoint: REVOCATION_ENDPOINT,
    grant_types_supported: ["authorization_code", "refresh_token"],
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["private_key_jwt"],
    token_endpoint_auth_signing_alg_values_supported: ASSERTION_ALGS,
    revocation_endpoint_auth_methods_supported: ["private_key_jwt"],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    scopes_supported: Object.keys(SCOPES),
    protected_resources: [`https://${DOMAIN}`],
  };
}

type RefreshToken = {
  clientId: string;
  account: string;
  scopes: string[];
  exp: number;
};
export type AccessToken = RefreshToken & { refreshToken: string };
type Code = {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scopes: string[];
  account: string;
  exp: number;
};

const state = once("company_oauth", () => ({
  refreshTokens: new Map<string, RefreshToken>(),
  accessTokens: new Map<string, AccessToken>(),
  codes: new Map<string, Code>(),
  assertionJtis: new Map<string, number>(),
}));

/** The access token a resource was sent, if it is still good. */
export function accessToken(value: string): AccessToken | undefined {
  const token = state.accessTokens.get(value);
  return token && token.exp > now() ? token : undefined;
}

/** `private_key_jwt` with the client's metadata document (spec 4.1). */
async function authenticate(form: URLSearchParams): Promise<ClientMetadata> {
  const refuse = (why: string) => new PoppyError(401, "invalid_client", why);
  const clientId = form.get("client_id") ?? "";
  if (
    form.get("client_assertion_type") !==
    "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
  )
    throw refuse("private_key_jwt is required");
  let metadata: ClientMetadata;
  try {
    metadata = await clientMetadata(clientId);
  } catch (err) {
    throw refuse((err as Error).message);
  }
  const assertion = form.get("client_assertion") ?? "";
  const { payload } = await jwtVerify(assertion, clientKeys(metadata), {
    issuer: clientId,
    subject: clientId,
    algorithms: ASSERTION_ALGS,
    maxTokenAge: "5m",
    requiredClaims: ["iat", "exp", "jti"],
  }).catch(() => {
    throw refuse("the client assertion does not verify");
  });
  // Exactly the issuer, as one string: never the token endpoint (spec 4.1).
  if (payload.aud !== ISSUER)
    throw refuse("the assertion's aud must be the issuer");
  const jti = String(payload.jti);
  for (const [id, exp] of state.assertionJtis)
    if (exp < now()) state.assertionJtis.delete(id);
  if (jti.length < 16 || state.assertionJtis.has(jti))
    throw refuse("the assertion's jti was used before");
  state.assertionJtis.set(jti, Number(payload.exp));
  return metadata;
}

function issue(grant: RefreshToken, refreshToken: string, scopes: string[]) {
  const token = `at_${random(24)}`;
  state.accessTokens.set(token, {
    ...grant,
    scopes,
    refreshToken,
    exp: now() + ACCESS_TOKEN_TTL,
  });
  return {
    access_token: token,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL,
    scope: scopes.join(" "),
  };
}

/** `POST /oauth/token`: the code exchange of Direct Sign-In, or a refresh (spec 4.2, 4.4). */
export async function token(request: Request) {
  const form = new URLSearchParams(await request.text());
  const metadata = await authenticate(form);
  const clientId = metadata.client_id;
  switch (form.get("grant_type")) {
    case "authorization_code": {
      const value = form.get("code") ?? "";
      const code = state.codes.get(value);
      state.codes.delete(value);
      if (
        !code ||
        code.exp < now() ||
        code.clientId !== clientId ||
        code.redirectUri !== form.get("redirect_uri") ||
        code.challenge !== (await sha256(form.get("code_verifier") ?? ""))
      )
        throw new PoppyError(
          400,
          "invalid_grant",
          "the code is invalid, expired or used",
        );
      const refreshToken = `rt_${random(24)}`;
      const grant = {
        clientId,
        account: code.account,
        scopes: code.scopes,
        exp: now() + REFRESH_TOKEN_TTL,
      };
      state.refreshTokens.set(refreshToken, grant);
      return {
        ...issue(grant, refreshToken, code.scopes),
        refresh_token: refreshToken,
      };
    }
    case "refresh_token": {
      const refreshToken = form.get("refresh_token") ?? "";
      const grant = state.refreshTokens.get(refreshToken);
      if (!grant || grant.exp < now() || grant.clientId !== clientId)
        throw new PoppyError(
          400,
          "invalid_grant",
          "the refresh token is invalid",
        );
      const asked = form.get("scope")?.split(" ").filter(Boolean);
      if (asked?.some((s) => !grant.scopes.includes(s)))
        throw new PoppyError(400, "invalid_scope", "beyond what was granted");
      return issue(grant, refreshToken, asked ?? grant.scopes);
    }
    default:
      throw new PoppyError(
        400,
        "unsupported_grant_type",
        "only authorization_code and refresh_token",
      );
  }
}

export type AuthorizeRequest = {
  metadata: ClientMetadata;
  redirectUri: string;
  state: string;
  scopes: Scope[];
  challenge: string;
};

/**
 * Checks the query of `GET /oauth/authorize`. A bad client or `redirect_uri`
 * throws, for the page to show; anything else is an error sent back to the
 * client, with `iss` (RFC 9207), as `redirect`.
 */
export async function authorizeRequest(
  query: URLSearchParams,
): Promise<AuthorizeRequest | { redirect: string }> {
  let metadata: ClientMetadata;
  try {
    metadata = await clientMetadata(query.get("client_id") ?? "");
  } catch (err) {
    throw new PoppyError(400, "invalid_client", (err as Error).message);
  }
  const redirectUri = query.get("redirect_uri") ?? "";
  if (!metadata.redirect_uris.includes(redirectUri))
    throw new PoppyError(
      400,
      "invalid_request",
      "redirect_uri is not one of the client's",
    );
  const back = (error: string) => {
    const url = new URL(redirectUri);
    url.searchParams.set("error", error);
    url.searchParams.set("state", query.get("state") ?? "");
    url.searchParams.set("iss", ISSUER);
    return { redirect: url.toString() };
  };
  if (
    query.get("response_type") !== "code" ||
    query.get("code_challenge_method") !== "S256" ||
    !query.get("code_challenge")
  )
    return back("invalid_request");
  // Every sign-in names its scopes, and only ones Flight Sector has (spec 4.7).
  const scopes = (query.get("scope") ?? "").split(" ").filter(Boolean);
  if (!scopes.length || scopes.some((s) => !(s in SCOPES)))
    return back("invalid_scope");
  return {
    metadata,
    redirectUri,
    state: query.get("state") ?? "",
    scopes: scopes as Scope[],
    challenge: query.get("code_challenge") ?? "",
  };
}

/** Sam's answer on the consent page: where to send the browser back to. */
export async function decide(
  query: URLSearchParams,
  approved: string[] | null,
): Promise<string> {
  const checked = await authorizeRequest(query);
  if ("redirect" in checked) return checked.redirect;
  const back = new URL(checked.redirectUri);
  back.searchParams.set("state", checked.state);
  back.searchParams.set("iss", ISSUER);
  // Never more than was asked; none at all is a decline (spec 4.7).
  const scopes = checked.scopes.filter((s) => approved?.includes(s));
  if (!scopes.length) {
    back.searchParams.set("error", "access_denied");
    return back.toString();
  }
  const code = `code_${random(18)}`;
  state.codes.set(code, {
    clientId: checked.metadata.client_id,
    redirectUri: checked.redirectUri,
    challenge: checked.challenge,
    scopes,
    account: ACCOUNT.id,
    exp: now() + CODE_TTL,
  });
  back.searchParams.set("code", code);
  return back.toString();
}

/**
 * `POST /oauth/revoke` (RFC 7009): the refresh token goes, and the access
 * tokens issued under it with it. Its Sessions continue signed out (spec 5.5).
 */
export async function revoke(request: Request) {
  const form = new URLSearchParams(await request.text());
  const metadata = await authenticate(form);
  const value = form.get("token") ?? "";
  if (state.refreshTokens.get(value)?.clientId === metadata.client_id) {
    state.refreshTokens.delete(value);
    for (const [token, record] of state.accessTokens)
      if (record.refreshToken === value) state.accessTokens.delete(token);
  }
  return {};
}
