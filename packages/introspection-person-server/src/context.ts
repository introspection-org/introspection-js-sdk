/** What every part of a Person Server shares: its options as resolved, its key and its store. */
import { createHash } from "node:crypto";

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

import { AAuthError } from "./errors.js";
import type { PersonServerOptions } from "./person-server.js";
import type { Budget, Store } from "./types.js";

type FetchLike = NonNullable<PersonServerOptions["fetch"]>;
type CryptoKeyLike = CryptoKey | KeyObject;

const ALG = "Ed25519";
export const DWK = "aauth-person.json";

interface Signer {
  kid: string;
  jwks: { keys: JWK[] };
  privateJwk: JWK;
  sign(claims: JWTPayload, typ: string): Promise<string>;
}

export async function loadSigner(pem: string | undefined): Promise<Signer> {
  const key: CryptoKeyLike = pem
    ? await importPKCS8(pem, ALG, { extractable: true })
    : (await generateKeyPair(ALG, { extractable: true })).privateKey;
  const exported = await exportJWK(key);
  const kid = await calculateJwkThumbprint(exported);
  const privateJwk = { ...exported, kid, alg: ALG };
  const publicJwk: JWK = { ...privateJwk };
  delete publicJwk.d;
  return {
    kid,
    jwks: { keys: [{ ...publicJwk, use: "sig" }] },
    privateJwk,
    sign: (claims, typ) =>
      new SignJWT(claims).setProtectedHeader({ alg: ALG, typ, kid }).sign(key),
  };
}

export interface Context {
  options: PersonServerOptions;
  issuer: string;
  base: string;
  store: Store;
  signer: Signer;
  secret: string;
  fetchLike: FetchLike;
  now: () => number;
  tokenTtl: number;
  missionTtl: number;
  approvalTtl: number;
  retryAfter: number;
  defaultTenant: string | undefined;
  tenantFor: (named: string | undefined) => string;
  trusted: (iss: string) => boolean;
  endpoints: { pending: (tenant: string, id: string) => string };
}

export const s256 = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("base64url");
export const trim = (url: string) => url.replace(/\/+$/, "");
/** The tenant a request body names; an empty one names none. */
export const tenantOf = (params: Record<string, unknown>) =>
  typeof params.tenant === "string" && params.tenant
    ? params.tenant
    : undefined;

export function readBody(body: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new AAuthError(400, "invalid_request", "body must be a JSON object");
}

export function readBudget(value: unknown): Budget | undefined {
  if (value === undefined || value === null) return undefined;
  const { amount, unit, decimals } = value as Partial<Budget>;
  if (
    typeof amount !== "number" ||
    !Number.isSafeInteger(amount) ||
    amount < 0 ||
    typeof unit !== "string" ||
    typeof decimals !== "number" ||
    !Number.isInteger(decimals) ||
    decimals < 0
  )
    throw new AAuthError(
      400,
      "invalid_request",
      "budget is {amount, unit, decimals}",
    );
  return { amount, unit, decimals };
}

export const sameScale = (a: Budget, b: Budget) =>
  a.unit === b.unit && a.decimals === b.decimals;

export function signatureError(code: string, detail: string): AAuthError {
  return new AAuthError(401, code, detail, {
    "Signature-Error": `error=${code}`,
  });
}
