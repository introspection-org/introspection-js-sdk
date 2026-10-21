import {
  type JWK,
  type JWTPayload,
  type KeyObject,
  SignJWT,
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  importPKCS8,
} from "jose";

const ALG = "Ed25519";

/** An AAuth server's Ed25519 key: it signs tokens and, as `sig=jwks_uri`, requests. */
export interface Signer {
  kid: string;
  jwks: { keys: JWK[] };
  privateJwk: JWK;
  sign(claims: JWTPayload, typ: string): Promise<string>;
}

/** The key in a PKCS#8 Ed25519 PEM, or a fresh one; its `kid` is its thumbprint unless given. */
export async function loadSigner(
  pem: string | undefined,
  kid?: string,
): Promise<Signer> {
  const key: CryptoKey | KeyObject = pem
    ? await importPKCS8(pem, ALG, { extractable: true })
    : (await generateKeyPair(ALG, { extractable: true })).privateKey;
  const exported = await exportJWK(key);
  const id = kid ?? (await calculateJwkThumbprint(exported));
  const privateJwk = { ...exported, kid: id, alg: ALG };
  const publicJwk: JWK = { ...privateJwk };
  delete publicJwk.d;
  return {
    kid: id,
    jwks: { keys: [{ ...publicJwk, use: "sig" }] },
    privateJwk,
    sign: (claims, typ) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: ALG, typ, kid: id })
        .sign(key),
  };
}
