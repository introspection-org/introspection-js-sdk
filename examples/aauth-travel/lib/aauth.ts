/**
 * The AAuth plumbing every server in this example shares: HTTP Message
 * Signature verification (RFC 9421, via @hellocoop/httpsig), token
 * verification by `{iss}/.well-known/{dwk}` discovery (via jose), the
 * AAuth-Requirement header, and problem responses.
 */
import "server-only";

import { createHash, randomUUID } from "node:crypto";

import {
  Token,
  generateAcceptSignatureSchemeHeader,
  generateSignatureErrorHeader,
  parseDictionary,
  serializeDictionary,
  verify,
  type SignatureErrorCode,
} from "@hellocoop/httpsig";
import {
  type JWK,
  type JWTPayload,
  calculateJwkThumbprint,
  createRemoteJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  errors,
  jwtVerify,
} from "jose";

export const TYP = {
  agent: "aa-agent+jwt",
  person: "aa-person+jwt",
  resource: "aa-resource+jwt",
  auth: "aa-auth+jwt",
} as const;

export const ALGORITHMS = ["Ed25519", "ES256"];
const METADATA_TTL_MS = 5 * 60 * 1000;
const BASE_COMPONENTS = ["@method", "@authority", "@path", "signature-key"];
const BODY_COMPONENTS = [...BASE_COMPONENTS, "content-type", "content-digest"];

/** An AAuth error, answered as application/problem+json. */
export class AAuthError extends Error {
  constructor(
    readonly status: number,
    readonly error: string,
    detail: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(detail);
  }
}

export function problem(
  status: number,
  error: string,
  detail?: string,
  headers: Record<string, string> = {},
): Response {
  return Response.json(
    { error, ...(detail ? { detail } : {}) },
    {
      status,
      headers: { "Content-Type": "application/problem+json", ...headers },
    },
  );
}

/** Run a handler, answering any AAuthError as a problem response. */
export async function respond(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AAuthError)
      return problem(err.status, err.error, err.message, err.headers);
    console.error(err);
    return problem(500, "server_error", (err as Error).message);
  }
}

/** `AAuth-Requirement: requirement=<value>; <params>` (an RFC 8941 Dictionary). */
export function requirement(
  value: string,
  params: Record<string, string> = {},
): string {
  return serializeDictionary(
    new Map([
      ["requirement", [new Token(value), new Map(Object.entries(params))]],
    ]),
  );
}

export function parseRequirement(
  header: string | null,
): { requirement: string; params: Record<string, string> } | null {
  if (!header) return null;
  const member = parseDictionary(header).get("requirement");
  if (!member || Array.isArray(member[0])) return null;
  const [value, params] = member as [Token, Map<string, unknown>];
  return {
    requirement: String(value),
    params: Object.fromEntries([...params].map(([key, v]) => [key, String(v)])),
  };
}

export const s256 = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("base64url");

export const newId = (prefix: string) => `${prefix}-${randomUUID()}`;

export const now = () => Math.floor(Date.now() / 1000);

/** A public JWK reduced to the members a `cnf` carries. */
export function publicJwk(jwk: JWK): JWK {
  const { kty, crv, x, y, n, e, alg } = jwk;
  return Object.fromEntries(
    Object.entries({ kty, crv, x, y, n, e, alg }).filter(([, v]) => v),
  ) as JWK;
}

export const thumbprint = (jwk: JWK) => calculateJwkThumbprint(publicJwk(jwk));

// #region verify-signature
export interface SignedRequest {
  keyType: "jwt" | "jwks_uri" | "hwk" | "jkt_jwt";
  /** JWK Thumbprint of the key that signed the request. */
  thumbprint: string;
  publicKey: JWK;
  /** The token in `Signature-Key: sig=jwt;jwt="…"`, not yet verified. */
  jwt?: { raw: string; typ: string; payload: JWTPayload };
  /** The server identity in `Signature-Key: sig=jwks_uri;id="…"`. */
  id?: string;
}

/**
 * Verify the RFC 9421 signature on a request against this server's canonical
 * authority and path (not the URL Next routed it to). A body must be covered
 * by `content-digest`. A failure is a 401 with `Signature-Error`.
 */
export async function verifySignature(
  request: Request,
  body: string | undefined,
  { authority, path }: { authority: string; path: string },
): Promise<SignedRequest> {
  const covered = body ? BODY_COMPONENTS : BASE_COMPONENTS;
  const input = parseDictionary(request.headers.get("signature-input") ?? "");
  const [label] = [...input.keys()];
  const components = label
    ? (input.get(label)![0] as [string, unknown][]).map(([name]) => name)
    : [];
  const missing = covered.filter((c) => !components.includes(c));
  if (label && missing.length)
    throw signatureError("invalid_input", `not covered: ${missing.join(" ")}`);

  const result = await verify(
    {
      method: request.method,
      authority,
      path,
      headers: request.headers,
      ...(body ? { body } : {}),
    },
    { requireContentDigest: true, supportedAlgorithms: ["Ed25519", "ES256"] },
  );
  if (!result.verified) {
    const code = result.signatureError?.error ?? "invalid_signature";
    throw signatureError(code, result.error ?? "signature does not verify");
  }
  return {
    keyType: result.keyType,
    thumbprint: result.thumbprint,
    publicKey: result.publicKey as JWK,
    ...(result.jwt
      ? {
          jwt: {
            raw: result.jwt.raw,
            typ: String((result.jwt.header as { typ?: string }).typ),
            payload: result.jwt.payload as JWTPayload,
          },
        }
      : {}),
    ...(result.jwks_uri ? { id: result.jwks_uri.id } : {}),
  };
}
// #endregion

export function signatureError(
  code: SignatureErrorCode,
  detail: string,
): AAuthError {
  const headers: Record<string, string> = {
    "Signature-Error": generateSignatureErrorHeader({ error: code }),
  };
  if (code === "unsupported_scheme")
    headers["Accept-Signature-Scheme"] = generateAcceptSignatureSchemeHeader([
      "jwt",
    ]);
  return new AAuthError(401, code, detail, headers);
}

// #region verify-token
const metadataCache = new Map<
  string,
  { at: number; doc: Promise<Record<string, unknown>> }
>();
const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * Fetch `{issuer}/.well-known/{dwk}` and insist its `issuer` is the one it was
 * fetched under, so one host cannot publish keys for another.
 */
export function metadata(
  issuer: string,
  dwk: string,
): Promise<Record<string, unknown>> {
  const url = `${issuer}/.well-known/${dwk}`;
  const cached = metadataCache.get(url);
  if (cached && Date.now() - cached.at < METADATA_TTL_MS) return cached.doc;
  const doc = (async () => {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    const document = (await response.json()) as Record<string, unknown>;
    if (document.issuer !== issuer)
      throw new Error(`${url} names issuer ${document.issuer}`);
    return document;
  })();
  doc.catch(() => metadataCache.delete(url));
  metadataCache.set(url, { at: Date.now(), doc });
  return doc;
}

export class TokenError extends Error {
  constructor(
    readonly reason: "invalid" | "expired" | "untrusted",
    message: string,
  ) {
    super(message);
  }
}

/**
 * Verify an AAuth JWT: its `typ`, its `dwk`, an issuer from the trusted list,
 * then its signature against the keys the issuer's metadata names, and `exp`.
 */
export async function verifyToken(
  token: string,
  {
    typ,
    dwk,
    issuers,
  }: { typ: string; dwk: string; issuers: readonly string[] },
): Promise<JWTPayload> {
  let header, claims;
  try {
    header = decodeProtectedHeader(token);
    claims = decodeJwt(token);
  } catch {
    throw new TokenError("invalid", "not a JWT");
  }
  if (header.typ !== typ)
    throw new TokenError("invalid", `typ is ${header.typ}, expected ${typ}`);
  if (claims.dwk !== dwk)
    throw new TokenError("invalid", `dwk is ${claims.dwk}, expected ${dwk}`);
  const iss = String(claims.iss);
  if (!issuers.includes(iss))
    throw new TokenError("untrusted", `${iss} is not a trusted issuer`);
  try {
    const document = await metadata(iss, dwk);
    const jwksUri = String(document.jwks_uri);
    if (!keySets.has(jwksUri))
      keySets.set(jwksUri, createRemoteJWKSet(new URL(jwksUri)));
    const keys = keySets.get(jwksUri)!;
    const options = {
      typ,
      issuer: iss,
      algorithms: ALGORITHMS,
      requiredClaims: ["exp", "iat", "jti"],
    };
    try {
      return (await jwtVerify(token, keys, options)).payload;
    } catch (err) {
      // A cached key under this kid may have rotated: refresh once and retry.
      if (!(err instanceof errors.JWSSignatureVerificationFailed)) throw err;
      await keys.reload();
      return (await jwtVerify(token, keys, options)).payload;
    }
  } catch (err) {
    if (err instanceof errors.JWTExpired)
      throw new TokenError("expired", "token expired");
    throw new TokenError("invalid", (err as Error).message);
  }
}
// #endregion

/** The `cnf.jwk` of a verified token must be the key that signed the request. */
export async function assertBound(
  claims: JWTPayload,
  signed: SignedRequest,
): Promise<void> {
  const jwk = (claims.cnf as { jwk?: JWK } | undefined)?.jwk;
  if (!jwk?.kty || !jwk.alg)
    throw signatureError("invalid_jwt", "cnf.jwk is missing or incomplete");
  if ((await thumbprint(jwk)) !== signed.thumbprint)
    throw signatureError("invalid_jwt", "cnf.jwk is not the signing key");
}
