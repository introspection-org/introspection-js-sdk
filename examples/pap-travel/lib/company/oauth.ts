/**
 * Flight Sector's side of PAP sessions and sign-in (spec §3–§4): discovery,
 * client verification by Client ID Metadata Document, the token endpoint,
 * Direct Sign-In and revocation. Session and Account Tokens are opaque; the
 * records behind them live here.
 */
import "server-only";

import { base64url, createRemoteJWKSet, jwtVerify } from "jose";

import { checkProof, DpopError } from "../dpop";
import { once } from "../once";
import { COMPANY_URL } from "../origins";

export const ISSUER = COMPANY_URL;
export const TOKEN_ENDPOINT = `${ISSUER}/oauth/token`;
export const AUTHORIZE_ENDPOINT = `${ISSUER}/oauth/authorize`;
export const REVOCATION_ENDPOINT = `${ISSUER}/oauth/revoke`;
export const CONVERSATIONS = `${COMPANY_URL}/poppy/conversations`;
export const SCOPES = ["poppy:read", "poppy:write"];

const SESSION_TOKEN_TTL = 3600;
const ACCOUNT_TOKEN_TTL = 30 * 24 * 3600;
const CODE_TTL = 120;

/** Sam's account: the demo's only customer. */
export const ACCOUNT = {
  id: "acct_sam",
  name: "Sam Reyes",
  email: "sam@acme.example",
};

export function poppyDocument() {
  return {
    protocol_version: "0.1",
    organization: {
      name: "Flight Sector",
      domain: new URL(COMPANY_URL).hostname,
    },
    auth: { issuer: ISSUER, direct: { scopes: SCOPES } },
    agent: { protocols: [{ type: "poppy", endpoint: CONVERSATIONS }] },
  };
}

export function serverMetadata() {
  return {
    issuer: ISSUER,
    token_endpoint: TOKEN_ENDPOINT,
    revocation_endpoint: REVOCATION_ENDPOINT,
    authorization_endpoint: AUTHORIZE_ENDPOINT,
    poppy_domains: [new URL(COMPANY_URL).hostname],
  };
}

/** An OAuth-style error: `{error, error_description}` with its status. */
export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly scope?: string,
  ) {
    super(message);
  }
}

type Session = {
  id: string;
  clientId: string;
  userId: string;
  account?: string;
};
type SessionToken = {
  sessionId: string;
  jkt: string;
  scopes: string[];
  exp: number;
};
type AccountToken = {
  clientId: string;
  userId: string;
  account: string;
  scopes: string[];
  exp: number;
};
type Code = {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scopes: string[];
  account: string;
  exp: number;
};

const state = once("company_oauth", () => ({
  sessions: new Map<string, Session>(),
  sessionTokens: new Map<string, SessionToken>(),
  accountTokens: new Map<string, AccountToken>(),
  codes: new Map<string, Code>(),
  assertionJtis: new Set<string>(),
}));

const random = (prefix: string, bytes = 18) =>
  `${prefix}${base64url.encode(crypto.getRandomValues(new Uint8Array(bytes)))}`;
const now = () => Math.floor(Date.now() / 1000);

export type ClientMetadata = {
  client_id: string;
  client_name: string;
  jwks_uri: string;
  redirect_uris: string[];
};

/** The Personal Agent's metadata, fetched from its `client_id` (spec §4.1). */
export async function clientMetadata(
  clientId: string,
): Promise<ClientMetadata> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    throw new OAuthError(401, "invalid_client", "client_id is not a URL");
  }
  if (url.protocol !== "https:")
    throw new OAuthError(401, "invalid_client", "client_id must be https");
  const response = await fetch(url, { cache: "no-store" }).catch(() => null);
  if (!response?.ok)
    throw new OAuthError(401, "invalid_client", "client metadata unavailable");
  const metadata = (await response.json()) as ClientMetadata;
  const sameHost = (u: string) => new URL(u).host === url.host;
  if (
    metadata.client_id !== clientId ||
    !sameHost(metadata.jwks_uri) ||
    !metadata.redirect_uris?.every(sameHost)
  )
    throw new OAuthError(
      401,
      "invalid_client",
      "client metadata does not check out",
    );
  return metadata;
}

async function verifyJwt(
  jwt: string,
  metadata: ClientMetadata,
  checks: { sub?: boolean },
) {
  const keys = createRemoteJWKSet(new URL(metadata.jwks_uri));
  const { payload } = await jwtVerify(jwt, keys, {
    issuer: metadata.client_id,
    audience: TOKEN_ENDPOINT,
    maxTokenAge: "5m",
  }).catch(() => {
    throw new OAuthError(400, "invalid_grant", "assertion does not verify");
  });
  if (Array.isArray(payload.aud))
    throw new OAuthError(400, "invalid_grant", "aud must be a single string");
  const jti = String(payload.jti ?? "");
  if (jti.length < 16 || state.assertionJtis.has(jti))
    throw new OAuthError(400, "invalid_grant", "assertion was reused");
  state.assertionJtis.add(jti);
  if (checks.sub && typeof payload.sub !== "string")
    throw new OAuthError(400, "invalid_grant", "assertion names no user");
  return payload;
}

function issueSessionToken(session: Session, jkt: string, scopes: string[]) {
  const token = random("st_", 24);
  state.sessionTokens.set(token, {
    sessionId: session.id,
    jkt,
    scopes,
    exp: now() + SESSION_TOKEN_TTL,
  });
  return {
    access_token: token,
    token_type: "DPoP",
    expires_in: SESSION_TOKEN_TTL,
    scope: scopes.join(" "),
    session_id: session.id,
    signed_in: Boolean(session.account),
  };
}

function ownedSession(sessionId: string, clientId: string, userId?: string) {
  const session = state.sessions.get(sessionId);
  if (
    !session ||
    session.clientId !== clientId ||
    (userId && session.userId !== userId)
  )
    throw new OAuthError(400, "invalid_session", "start a new Session");
  return session;
}

function requestedScopes(raw: string | null, allowed: string[]): string[] {
  if (!raw) return allowed;
  const asked = raw.split(" ").filter(Boolean);
  if (asked.some((s) => !allowed.includes(s)))
    throw new OAuthError(400, "invalid_scope", "scope beyond what was granted");
  return asked;
}

async function pkceChallenge(verifier: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64url.encode(new Uint8Array(digest));
}

/** `POST /oauth/token`: start or renew a Session, finish Direct Sign-In, or use an Account Token. */
export async function token(request: Request) {
  const form = new URLSearchParams(await request.text());
  let jkt: string;
  try {
    jkt = await checkProof(request.headers.get("dpop"), "POST", TOKEN_ENDPOINT);
  } catch (err) {
    if (err instanceof DpopError)
      throw new OAuthError(400, "invalid_dpop_proof", err.message);
    throw err;
  }
  const clientId = form.get("client_id") ?? "";
  const metadata = await clientMetadata(clientId);
  if (
    form.get("client_assertion_type") !==
    "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
  )
    throw new OAuthError(401, "invalid_client", "private_key_jwt is required");
  await verifyJwt(form.get("client_assertion") ?? "", metadata, {}).catch(
    () => {
      throw new OAuthError(
        401,
        "invalid_client",
        "client assertion does not verify",
      );
    },
  );

  const sessionId = form.get("session_id");
  switch (form.get("grant_type")) {
    case "urn:ietf:params:oauth:grant-type:jwt-bearer": {
      const assertion = await verifyJwt(form.get("assertion") ?? "", metadata, {
        sub: true,
      });
      const userId = String(assertion.sub);
      const session = sessionId
        ? ownedSession(sessionId, clientId, userId)
        : { id: random("ses_", 9), clientId, userId };
      state.sessions.set(session.id, session);
      return issueSessionToken(session, jkt, []);
    }
    case "authorization_code": {
      const code = state.codes.get(form.get("code") ?? "");
      state.codes.delete(form.get("code") ?? "");
      if (
        !code ||
        code.exp < now() ||
        code.clientId !== clientId ||
        code.redirectUri !== form.get("redirect_uri") ||
        code.challenge !==
          (await pkceChallenge(form.get("code_verifier") ?? ""))
      )
        throw new OAuthError(
          400,
          "invalid_grant",
          "the code is invalid, expired or used",
        );
      const session = ownedSession(sessionId ?? "", clientId);
      if (session.account && session.account !== code.account)
        throw new OAuthError(400, "account_mismatch", "start a new Session");
      session.account = code.account;
      const accountToken = random("pat_", 24);
      state.accountTokens.set(accountToken, {
        clientId,
        userId: session.userId,
        account: code.account,
        scopes: code.scopes,
        exp: now() + ACCOUNT_TOKEN_TTL,
      });
      return {
        ...issueSessionToken(session, jkt, code.scopes),
        refresh_token: accountToken,
        refresh_token_expires_in: ACCOUNT_TOKEN_TTL,
      };
    }
    case "refresh_token": {
      const grant = state.accountTokens.get(form.get("refresh_token") ?? "");
      if (!grant || grant.exp < now() || grant.clientId !== clientId)
        throw new OAuthError(
          400,
          "invalid_grant",
          "the Account Token is invalid",
        );
      const scopes = requestedScopes(form.get("scope"), grant.scopes);
      const session = sessionId
        ? ownedSession(sessionId, clientId, grant.userId)
        : { id: random("ses_", 9), clientId, userId: grant.userId };
      if (session.account && session.account !== grant.account)
        throw new OAuthError(400, "account_mismatch", "start a new Session");
      session.account = grant.account;
      state.sessions.set(session.id, session);
      return issueSessionToken(session, jkt, scopes);
    }
    default:
      throw new OAuthError(
        400,
        "unsupported_grant_type",
        "unsupported grant_type",
      );
  }
}

export type AuthorizeRequest = {
  clientId: string;
  redirectUri: string;
  state: string;
  scopes: string[];
  challenge: string;
};

/** Checks the query of `GET /oauth/authorize` before the consent page shows it. */
export async function authorizeRequest(query: URLSearchParams) {
  const metadata = await clientMetadata(query.get("client_id") ?? "");
  const redirectUri = query.get("redirect_uri") ?? "";
  if (!metadata.redirect_uris.includes(redirectUri))
    throw new OAuthError(
      400,
      "invalid_request",
      "redirect_uri is not registered",
    );
  if (
    query.get("response_type") !== "code" ||
    query.get("code_challenge_method") !== "S256"
  )
    throw new OAuthError(
      400,
      "invalid_request",
      "use the code flow with S256 PKCE",
    );
  return {
    metadata,
    request: {
      clientId: metadata.client_id,
      redirectUri,
      state: query.get("state") ?? "",
      scopes: requestedScopes(query.get("scope"), SCOPES),
      challenge: query.get("code_challenge") ?? "",
    } satisfies AuthorizeRequest,
  };
}

/** Sam's decision on the consent page: where to send the browser back to. */
export async function decide(
  query: URLSearchParams,
  approved: string[] | null,
): Promise<string> {
  const { request } = await authorizeRequest(query);
  const back = new URL(request.redirectUri);
  back.searchParams.set("state", request.state);
  back.searchParams.set("iss", ISSUER);
  if (!approved?.length) {
    back.searchParams.set("error", "access_denied");
    return back.toString();
  }
  const code = random("code_", 18);
  state.codes.set(code, {
    clientId: request.clientId,
    redirectUri: request.redirectUri,
    challenge: request.challenge,
    scopes: request.scopes.filter((s) => approved.includes(s)),
    account: ACCOUNT.id,
    exp: now() + CODE_TTL,
  });
  back.searchParams.set("code", code);
  return back.toString();
}

/** `POST /oauth/revoke`: the Account Token goes, and its Sessions continue signed out. */
export async function revoke(request: Request) {
  const form = new URLSearchParams(await request.text());
  const metadata = await clientMetadata(form.get("client_id") ?? "");
  await verifyJwt(form.get("client_assertion") ?? "", metadata, {}).catch(
    () => {
      throw new OAuthError(
        401,
        "invalid_client",
        "client assertion does not verify",
      );
    },
  );
  const grant = state.accountTokens.get(form.get("token") ?? "");
  if (grant?.clientId === metadata.client_id) {
    state.accountTokens.delete(form.get("token") ?? "");
    for (const session of state.sessions.values())
      if (
        session.clientId === grant.clientId &&
        session.account === grant.account
      )
        delete session.account;
  }
  return {};
}

export type Caller = {
  clientId: string;
  userId: string;
  session: Session;
  scopes: string[];
};

/** Who a conversation request is from: its Session Token, checked with its proof (spec §4.3). */
export async function caller(request: Request, url: string): Promise<Caller> {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("DPoP "))
    throw new OAuthError(
      401,
      "invalid_token",
      "a DPoP Session Token is required",
    );
  const value = header.slice(5).trim();
  const record = state.sessionTokens.get(value);
  if (!record || record.exp < now())
    throw new OAuthError(
      401,
      "invalid_token",
      "the Session Token is unknown or expired",
    );
  let jkt: string;
  try {
    jkt = await checkProof(
      request.headers.get("dpop"),
      request.method,
      url,
      value,
    );
  } catch (err) {
    if (err instanceof DpopError)
      throw new OAuthError(401, "invalid_dpop_proof", err.message);
    throw err;
  }
  if (jkt !== record.jkt)
    throw new OAuthError(
      401,
      "invalid_dpop_proof",
      "the proof's key is not the token's",
    );
  const session = state.sessions.get(record.sessionId)!;
  // A token minted signed-in reads as signed out once its Account Token is revoked.
  const scopes = session.account ? record.scopes : [];
  return {
    clientId: session.clientId,
    userId: session.userId,
    session,
    scopes,
  };
}
