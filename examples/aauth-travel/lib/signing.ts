/**
 * Ed25519 signing keys for what this app signs: booking quotes and resource
 * tokens (as the provider), and person and auth tokens (as Acme's Person
 * Server). Set a PEM in the environment to keep a key across restarts;
 * otherwise each process makes its own, which is fine for a local demo.
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

/** RFC 9864's fully-specified identifier; the polymorphic `EdDSA` is not used. */
export const ALG = "Ed25519";

export interface Signer {
  kid: string;
  jwks: { keys: JWK[] };
  /** The private half as a JWK, for signing HTTP requests. */
  privateJwk: JWK;
  sign(claims: Record<string, unknown>, typ?: string): Promise<string>;
  /** Sign with a header already built, as @aauth/resource hands it over. */
  signWithHeader(
    claims: Record<string, unknown>,
    header: Record<string, unknown>,
  ): Promise<string>;
}

async function load(kid: string, pem: string | undefined): Promise<Signer> {
  const privateKey: CryptoKey = pem
    ? await importPKCS8(pem, ALG, { extractable: true })
    : (await generateKeyPair(ALG, { extractable: true })).privateKey;
  const privateJwk = { ...(await exportJWK(privateKey)), kid, alg: ALG };
  const { d: _private, ...publicJwk } = privateJwk;
  const signWithHeader = (
    claims: Record<string, unknown>,
    header: Record<string, unknown>,
  ) =>
    new SignJWT(claims)
      .setProtectedHeader({ ...header, alg: ALG, kid } as { alg: string })
      .sign(privateKey);
  return {
    kid,
    jwks: { keys: [{ ...publicJwk, use: "sig" }] },
    privateJwk,
    sign: (claims, typ = "JWT") => signWithHeader(claims, { typ }),
    signWithHeader,
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
