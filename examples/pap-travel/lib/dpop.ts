/** DPoP proofs (RFC 9449): Atlas makes them, Flight Sector checks them. */
import {
  base64url,
  calculateJwkThumbprint,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  importJWK,
  jwtVerify,
  SignJWT,
  type JWK,
} from "jose";

import { once } from "./once";

export type KeyPair = { privateKey: CryptoKey; publicJwk: JWK };

export async function newKeyPair(): Promise<KeyPair> {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  return { privateKey, publicJwk: await exportJWK(publicKey) };
}

export async function tokenHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token),
  );
  return base64url.encode(new Uint8Array(digest));
}

export async function proof(
  key: KeyPair,
  method: string,
  url: string,
  options: { token?: string; nonce?: string } = {},
): Promise<string> {
  const target = new URL(url);
  return new SignJWT({
    jti: crypto.randomUUID(),
    htm: method,
    htu: `${target.origin}${target.pathname}`,
    ...(options.token && { ath: await tokenHash(options.token) }),
    ...(options.nonce && { nonce: options.nonce }),
  })
    .setProtectedHeader({ typ: "dpop+jwt", alg: "ES256", jwk: key.publicJwk })
    .setIssuedAt()
    .sign(key.privateKey);
}

const WINDOW_SECONDS = 60;
const seen = once("dpop_seen", () => new Map<string, number>());

export class DpopError extends Error {}

/** Checks a proof for `htu` and, past the token endpoint, the token it travels with. Returns the key's thumbprint. */
export async function checkProof(
  header: string | null,
  method: string,
  htu: string,
  token?: string,
): Promise<string> {
  if (!header) throw new DpopError("missing DPoP proof");
  let jwk: JWK;
  try {
    const protectedHeader = decodeProtectedHeader(header);
    if (protectedHeader.typ !== "dpop+jwt" || !protectedHeader.jwk)
      throw new Error();
    jwk = protectedHeader.jwk as JWK;
  } catch {
    throw new DpopError("malformed DPoP proof");
  }
  const { payload } = await jwtVerify(header, await importJWK(jwk, "ES256"), {
    typ: "dpop+jwt",
  }).catch(() => {
    throw new DpopError("DPoP signature does not verify");
  });
  const now = Math.floor(Date.now() / 1000);
  if (payload.htm !== method || payload.htu !== htu)
    throw new DpopError("DPoP proof is for another request");
  if (
    typeof payload.iat !== "number" ||
    Math.abs(now - payload.iat) > WINDOW_SECONDS
  )
    throw new DpopError("DPoP proof is stale");
  const jti = String(payload.jti ?? "");
  for (const [id, at] of seen) if (now - at > WINDOW_SECONDS) seen.delete(id);
  if (!jti || seen.has(jti)) throw new DpopError("DPoP proof was replayed");
  seen.set(jti, now);
  if (token !== undefined && payload.ath !== (await tokenHash(token)))
    throw new DpopError("DPoP proof is for another token");
  return calculateJwkThumbprint(jwk);
}
