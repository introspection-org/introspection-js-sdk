/**
 * ES256 signing keys for what this app signs: booking quotes and resource
 * tokens (as the provider), and auth tokens (as Acme's Person Server). Set a PEM in the environment to keep keys stable across
 * restarts; otherwise each server process makes its own, which is fine for a
 * local demo.
 */
import "server-only";

import {
  type CryptoKey,
  type JWK,
  SignJWT,
  exportJWK,
  generateKeyPair,
  importPKCS8,
} from "jose";

export interface Signer {
  kid: string;
  jwks: { keys: JWK[] };
  /** The private half as a JWK, for signing HTTP requests. */
  privateJwk: JWK;
  sign(claims: Record<string, unknown>, typ?: string): Promise<string>;
}

async function load(kid: string, pem: string | undefined): Promise<Signer> {
  let privateKey: CryptoKey;
  if (pem) {
    privateKey = await importPKCS8(pem, "ES256", { extractable: true });
  } else {
    privateKey = (await generateKeyPair("ES256", { extractable: true }))
      .privateKey;
  }
  const privateJwk = { ...(await exportJWK(privateKey)), kid, alg: "ES256" };
  const { d: _private, ...publicJwk } = privateJwk;
  return {
    kid,
    jwks: { keys: [{ ...publicJwk, use: "sig" }] },
    privateJwk,
    sign: (claims, typ = "JWT") =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "ES256", typ, kid })
        .sign(privateKey),
  };
}

// One signer per process, shared across route modules (Next bundles each
// route separately, so module scope alone would mint a key per route).
const registry = globalThis as unknown as {
  __flightSectorSigners?: Map<string, Promise<Signer>>;
};
const signers = (registry.__flightSectorSigners ??= new Map());

function signer(kid: string, pem: string | undefined): Promise<Signer> {
  if (!signers.has(kid)) signers.set(kid, load(kid, pem));
  return signers.get(kid)!;
}

export const bookingSigner = () =>
  signer("flightsector-booking-1", process.env.BOOKING_SIGNING_KEY);

export const personServerSigner = () =>
  signer("acme-person-server-1", process.env.ACME_PS_SIGNING_KEY);
