/**
 * Atlas's identity (spec 4.1, 5.2): its Client ID Metadata Document, the key
 * in its `jwks_uri`, which signs only client assertions and delegations, and a
 * delegated key per User ID, which signs that User's Session JWTs.
 */
import "server-only";

import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  type JWK,
  SignJWT,
} from "jose";

import { now, random, sha256 } from "../crypto";
import { once } from "../once";
import { ATLAS_URL } from "../origins";

export const CLIENT_ID = `${ATLAS_URL}/agent.json`;
export const REDIRECT_URI = `${ATLAS_URL}/oauth/callback`;
const KID = "atlas-2026-10";
/** Delegations last an hour, well inside the 24 hours a Company accepts. */
const DELEGATION_TTL = 3600;

async function keyPair() {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  return { privateKey, publicJwk: await exportJWK(publicKey) };
}

const identity = once("atlas_identity", keyPair);

export function clientMetadata() {
  return {
    client_id: CLIENT_ID,
    client_name: "Atlas",
    jwks_uri: `${ATLAS_URL}/jwks.json`,
    redirect_uris: [REDIRECT_URI],
    token_endpoint_auth_method: "private_key_jwt",
    extensions: { operations: { version: "2" } },
  };
}

export async function jwks() {
  const { publicJwk } = await identity;
  return { keys: [{ ...publicJwk, kid: KID, alg: "ES256", use: "sig" }] };
}

/** A client assertion for a Company's token or revocation endpoint: `aud` is exactly its issuer (spec 4.1). */
export async function clientAssertion(issuer: string) {
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: KID })
    .setIssuer(CLIENT_ID)
    .setSubject(CLIENT_ID)
    .setAudience(issuer)
    .setIssuedAt()
    .setExpirationTime("60s")
    .setJti(random())
    .sign((await identity).privateKey);
}

type Delegated = {
  privateKey: CryptoKey;
  thumbprint: string;
  delegation: string;
  exp: number;
};

/** One delegated key per User ID, so no two Companies see the same key (spec 5.2). */
const delegated = once("atlas_delegated", () => new Map<string, Delegated>());

async function delegatedKey(userId: string): Promise<Delegated> {
  const current = delegated.get(userId);
  if (current && current.exp - now() > 60) return current;
  const { privateKey, publicJwk } = await keyPair();
  const iat = now();
  // Names the key and nothing about the User or the Company.
  const delegation = await new SignJWT({ cnf: { jwk: publicJwk } })
    .setProtectedHeader({ alg: "ES256", typ: "poppy-delegation+jwt", kid: KID })
    .setIssuer(CLIENT_ID)
    .setIssuedAt(iat)
    .setExpirationTime(iat + DELEGATION_TTL)
    .setJti(random())
    .sign((await identity).privateKey);
  const fresh = {
    privateKey,
    thumbprint: await calculateJwkThumbprint(publicJwk as JWK),
    delegation,
    exp: iat + DELEGATION_TTL,
  };
  delegated.set(userId, fresh);
  return fresh;
}

export type SessionClaims = {
  /** The Company's identifier: its issuer. */
  aud: string;
  sid: string;
  /** The User ID for this Company. */
  sub: string;
};

/** The `Poppy-Session` JWT for one request (spec 5.2). */
export async function sessionJwt(
  session: SessionClaims,
  method: string,
  url: string,
  accessToken?: string,
) {
  const key = await delegatedKey(session.sub);
  const target = new URL(url);
  return new SignJWT({
    sid: session.sid,
    htm: method,
    htu: `${target.origin}${target.pathname}`,
    ...(accessToken && { ath: await sha256(accessToken) }),
  })
    .setProtectedHeader({
      typ: "poppy-session+jwt",
      alg: "ES256",
      kid: key.thumbprint,
      poppy_dlg: key.delegation,
    })
    .setIssuer(CLIENT_ID)
    .setAudience(session.aud)
    .setSubject(session.sub)
    .setIssuedAt()
    .setJti(random())
    .sign(key.privateKey);
}
