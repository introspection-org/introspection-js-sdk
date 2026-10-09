/**
 * The AAuth plumbing the provider and the Person Server share. Signatures are
 * @hellocoop/httpsig's and tokens and headers @aauth/resource's (both the
 * spec author's); what is here is the glue: which issuers each server trusts,
 * and problem responses.
 */
import "server-only";

import { createHash } from "node:crypto";

import {
  generateAcceptSignatureSchemeHeader,
  generateSignatureErrorHeader,
  verify,
  type SignatureErrorCode,
} from "@hellocoop/httpsig";
import {
  AAuthTokenError,
  type TokenKind,
  type VerifiedToken,
  discoverJwks,
  verifyToken,
} from "@aauth/resource";
import { type JWTPayload, createLocalJWKSet, decodeJwt, jwtVerify } from "jose";

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

export const s256 = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("base64url");

export const now = () => Math.floor(Date.now() / 1000);

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

// #region verify-signature
export interface SignedRequest {
  keyType: "jwt" | "jwks_uri" | "hwk" | "jkt_jwt";
  /** JWK Thumbprint of the key that signed the request. */
  thumbprint: string;
  /** The token in `Signature-Key: sig=jwt;jwt="…"`, not yet verified. */
  jwt?: string;
  /** The server in `Signature-Key: sig=jwks_uri;id="…"`, verified against its keys. */
  server?: string;
}

/**
 * Verify the RFC 9421 signature on a request, as addressed to `url` (this
 * server's own host, not the path Next routed it to). A body must be covered
 * by `content-digest`.
 */
export async function verifySignature(
  request: Request,
  body: string | undefined,
  url: string,
): Promise<SignedRequest> {
  const { host, pathname } = new URL(url);
  const result = await verify(
    {
      method: request.method,
      authority: host,
      path: pathname,
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
    ...(result.jwt ? { jwt: result.jwt.raw } : {}),
    ...(result.jwks_uri ? { server: result.jwks_uri.id } : {}),
  };
}
// #endregion

// #region verify-token
/**
 * The token a request presented, verified by @aauth/resource: its kind is one
 * `accept` names, its issuer is one this server trusts for that kind (checked
 * first, since verifying fetches the issuer's keys), and it binds the key that
 * signed the request.
 */
export async function verifyPresented(
  signed: SignedRequest,
  {
    audience,
    accept,
    issuers,
  }: {
    audience: string;
    accept: TokenKind[];
    issuers: Partial<Record<TokenKind, readonly string[]>>;
  },
): Promise<VerifiedToken> {
  if (signed.keyType !== "jwt" || !signed.jwt)
    throw signatureError("unsupported_scheme", "sign with sig=jwt");
  let claims: JWTPayload;
  try {
    claims = decodeJwt(signed.jwt);
  } catch {
    throw signatureError("invalid_jwt", "not a JWT");
  }
  const trusted = accept.some((kind) =>
    issuers[kind]?.includes(String(claims.iss)),
  );
  if (!trusted)
    throw signatureError(
      "invalid_jwt",
      `${String(claims.iss)} is not trusted here`,
    );
  return verifyToken({
    jwt: signed.jwt,
    httpSignatureThumbprint: signed.thumbprint,
    resource: audience,
    accept,
  }).catch((err: Error) => {
    const code = err instanceof AAuthTokenError ? err.code : "invalid_jwt";
    throw signatureError(
      code === "token_expired" ? "expired_jwt" : "invalid_jwt",
      err.message,
    );
  });
}

/** Verify a JWT another server issued, against the keys its metadata names. */
export async function verifyIssued(
  token: string,
  {
    typ,
    dwk,
    issuers,
  }: { typ: string; dwk: string; issuers: readonly string[] },
): Promise<JWTPayload> {
  const iss = String(decodeJwt(token).iss);
  if (!issuers.includes(iss)) throw new Error(`${iss} is not trusted here`);
  const jwks = await discoverJwks({ iss, dwk });
  return (
    await jwtVerify(token, createLocalJWKSet(jwks), {
      typ,
      issuer: iss,
      algorithms: ["Ed25519", "ES256"],
    })
  ).payload;
}
// #endregion
