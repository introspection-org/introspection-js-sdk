/** Plumbing every AAuth server here shares: discovery, routing, signatures and errors. */
import { type VerificationResult, verify } from "@hellocoop/httpsig";
import type { JWK } from "jose";

import { AAuthError, problem } from "./errors.js";

/** `401` with `Signature-Error`, for a request whose signature or signing token fails. */
export function signatureError(code: string, detail: string): AAuthError {
  return new AAuthError(401, code, detail, {
    "Signature-Error": `error=${code}`,
  });
}

/**
 * Verify a request's RFC 9421 signature as it was addressed: `authority` and
 * `path`, whatever routed it here. A body must be covered by `content-digest`,
 * as the profile requires of a request to a Person Server or Access Server.
 */
export async function verifySignature(
  request: Request,
  body: string | undefined,
  authority: string,
  path: string,
): Promise<VerificationResult> {
  const signed = await verify(
    {
      method: request.method,
      authority,
      path,
      headers: request.headers,
      ...(body ? { body } : {}),
    },
    { requireContentDigest: true, supportedAlgorithms: ["Ed25519", "ES256"] },
  );
  if (!signed.verified)
    throw signatureError(
      signed.signatureError?.error ?? "invalid_signature",
      signed.error ?? "signature does not verify",
    );
  return signed;
}

/** `/.well-known/{dwk}` and `/.well-known/jwks.json`; undefined for any other request. */
export function discovery(
  request: Request,
  pathname: string,
  dwk: string,
  metadata: () => Record<string, unknown>,
  jwks: { keys: JWK[] },
): Response | undefined {
  if (request.method !== "GET") return undefined;
  if (pathname === `/.well-known/${dwk}`) return Response.json(metadata());
  if (pathname === "/.well-known/jwks.json") return Response.json(jwks);
  return undefined;
}

/** The route a path names under `base`; undefined when it is not under it. */
export const beneath = (pathname: string, base: string) =>
  !base || pathname.startsWith(`${base}/`)
    ? pathname.slice(base.length)
    : undefined;

/** Answer `route`'s response, an AAuth error as its problem, nothing as a 404, and anything else as a 500. */
export async function answer(
  route: () => Promise<Response | undefined>,
): Promise<Response> {
  try {
    return (await route()) ?? problem(404, "not_found");
  } catch (err) {
    if (err instanceof AAuthError)
      return problem(err.status, err.error, err.message, err.headers);
    return problem(500, "server_error", (err as Error).message);
  }
}
