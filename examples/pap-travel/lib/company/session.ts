/**
 * The `Poppy-Session` header, verified as spec 5.3 describes: the client's
 * metadata and keys, the delegation in `poppy_dlg` and the delegated key it
 * vouches for, the claims, the access token it covers, and the Session it
 * names. Any failure is `invalid_session` (HTTP 400, JSON body).
 */
import "server-only";

import {
  calculateJwkThumbprint,
  decodeJwt,
  decodeProtectedHeader,
  importJWK,
  type JWK,
  jwtVerify,
} from "jose";

import { now, sha256 } from "../crypto";
import { once } from "../once";
import { type ClientMetadata, clientKeys, clientMetadata } from "./clients";
import { PoppyError } from "./errors";
import { accessToken, ISSUER } from "./oauth";

const WINDOW_SECONDS = 60;
const SKEW_SECONDS = 5;
const DAY = 24 * 3600;
const PRIVATE_MEMBERS = ["d", "p", "q", "dp", "dq", "qi", "k"];
const SID = /^[A-Za-z0-9_-]{22,256}$/;

type Session = {
  clientId: string;
  sid: string;
  userId: string;
  agentId?: string;
  /** The account its signed-in requests used. */
  account?: string;
};

/** A verified request: who it is from, its Session, and the account and scopes its access token carries. */
export type Caller = {
  clientId: string;
  metadata: ClientMetadata;
  userId: string;
  sid: string;
  account?: string;
  scopes: string[];
};

const state = once("company_sessions", () => ({
  sessions: new Map<string, Session>(),
  /** Verified delegations by their SHA-256, until they expire: never by `jti`, which a forgery could copy. */
  delegations: new Map<string, { jwk: JWK; exp: number }>(),
  jtis: new Map<string, number>(),
}));

const invalid = (why: string) => new PoppyError(400, "invalid_session", why);

async function delegatedKey(
  delegation: string,
  iss: string,
  metadata: ClientMetadata,
): Promise<JWK> {
  const hash = await sha256(delegation);
  const cached = state.delegations.get(hash);
  if (cached && cached.exp > now()) return cached.jwk;
  const { payload, protectedHeader } = await jwtVerify(
    delegation,
    clientKeys(metadata),
    { algorithms: ["ES256", "PS384"], typ: "poppy-delegation+jwt" },
  ).catch(() => {
    throw invalid("the delegation does not verify with a key in jwks_uri");
  });
  if (!protectedHeader.kid) throw invalid("the delegation names no kid");
  if (payload.iss !== iss) throw invalid("the delegation is another client's");
  const { iat, exp } = payload;
  if (typeof iat !== "number" || typeof exp !== "number" || exp - iat > DAY)
    throw invalid("a delegation lasts at most 24 hours");
  const jwk = (payload.cnf as { jwk?: JWK } | undefined)?.jwk;
  if (!jwk || PRIVATE_MEMBERS.some((m) => m in jwk))
    throw invalid("the delegation's cnf.jwk is not a public key");
  state.delegations.set(hash, { jwk, exp });
  return jwk;
}

/**
 * Verifies the request's Session header for `htu`, the URL Flight Sector
 * publishes for it (not the Host it arrived with), and joins it with the
 * access token, if there is one.
 */
export async function verify(request: Request, htu: string): Promise<Caller> {
  const jwt = request.headers.get("poppy-session");
  if (!jwt) throw invalid("the Poppy-Session header is missing");
  let header: ReturnType<typeof decodeProtectedHeader>;
  let claims: ReturnType<typeof decodeJwt>;
  try {
    header = decodeProtectedHeader(jwt);
    claims = decodeJwt(jwt);
  } catch {
    throw invalid("the Session JWT is malformed");
  }
  if (typeof header.poppy_dlg !== "string")
    throw invalid("the Session JWT carries no delegation");
  const iss = String(claims.iss ?? "");

  // 1. The client, from its metadata document.
  let metadata: ClientMetadata;
  try {
    metadata = await clientMetadata(iss);
  } catch (err) {
    throw invalid((err as Error).message);
  }

  // 2. The delegation, then the Session JWT with the key it vouches for.
  const jwk = await delegatedKey(header.poppy_dlg, iss, metadata);
  if (header.kid !== (await calculateJwkThumbprint(jwk)))
    throw invalid("kid is not the delegated key's thumbprint");
  const { payload } = await jwtVerify(jwt, await importJWK(jwk, "ES256"), {
    algorithms: ["ES256"],
    typ: "poppy-session+jwt",
  }).catch(() => {
    throw invalid("the Session JWT does not verify with the delegated key");
  });
  if (payload.aud !== ISSUER)
    throw invalid("aud is not Flight Sector's issuer");
  if (payload.htm !== request.method || payload.htu !== htu)
    throw invalid("htm and htu are for another request");
  const iat = Number(payload.iat);
  if (!(Math.abs(now() - iat) <= WINDOW_SECONDS + SKEW_SECONDS))
    throw invalid("iat is outside the acceptance window");
  const jti = String(payload.jti ?? "");
  for (const [id, at] of state.jtis)
    if (now() - at > WINDOW_SECONDS + SKEW_SECONDS) state.jtis.delete(id);
  if (jti.length < 22 || state.jtis.has(jti))
    throw invalid("the Session JWT was used before");
  state.jtis.set(jti, iat);
  const sid = String(payload.sid ?? "");
  const userId = payload.sub;
  if (!SID.test(sid) || typeof userId !== "string" || !userId)
    throw invalid("sid and sub are required");
  const agentId =
    typeof payload.agent_id === "string" ? payload.agent_id : undefined;

  // 3. The access token, if any: `ath` covers it, and it is this client's.
  const authorization = request.headers.get("authorization") ?? "";
  const bearer = authorization.match(/^Bearer (.+)$/)?.[1];
  const token = bearer ? accessToken(bearer) : undefined;
  if (authorization && !token)
    throw new PoppyError(
      401,
      "invalid_token",
      "the access token is unknown, expired or revoked",
      'Bearer error="invalid_token"',
    );
  if (bearer ? payload.ath !== (await sha256(bearer)) : "ath" in payload)
    throw invalid("ath does not match the access token");
  if (token && token.clientId !== iss)
    throw invalid("the access token was issued to another client");

  // 4. The Session: a new `sid` starts one; a known one must be the same User's.
  const key = `${iss}\n${sid}`;
  const session = state.sessions.get(key) ?? {
    clientId: iss,
    sid,
    userId,
    agentId,
  };
  if (session.userId !== userId || session.agentId !== agentId)
    throw invalid("the Session belongs to another User ID or Agent ID");
  if (token && session.account && session.account !== token.account)
    throw new PoppyError(
      400,
      "session_ended",
      "this Session used another account; start a new one",
    );
  if (token) session.account = token.account;
  state.sessions.set(key, session);

  return {
    clientId: iss,
    metadata,
    userId,
    sid,
    account: token?.account,
    scopes: token?.scopes ?? [],
  };
}
