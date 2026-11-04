import type { JWTPayload } from "jose";

import type { Budget } from "./budget.js";

/** The longest a person token or an auth token may live (#token-lifetimes), in seconds. */
export const MAX_TOKEN_LIFETIME = 60 * 60;

/** A configured token lifetime, never longer than `MAX_TOKEN_LIFETIME`. */
export const tokenLifetime = (configured?: number): number =>
  Math.min(configured ?? MAX_TOKEN_LIFETIME, MAX_TOKEN_LIFETIME);

/** An identifier as compared: a server identifier carries no trailing slash. */
export const trimIdentifier = (value: string): string =>
  value.replace(/\/+$/, "");

/**
 * What is wrong with a verified token's shape, or undefined: every AAuth token
 * carries a `jti`, the `dwk` of the document its issuer's keys come from, and,
 * for a person token or an auth token, a lifetime of at most an hour.
 */
export function tokenProblem(
  claims: JWTPayload,
  expected: { dwk?: string; maxLifetime?: number },
): string | undefined {
  if (typeof claims.jti !== "string" || !claims.jti) return "has no jti";
  if (expected.dwk !== undefined && claims.dwk !== expected.dwk)
    return `has a dwk other than ${expected.dwk}`;
  if (expected.maxLifetime === undefined) return undefined;
  if (typeof claims.iat !== "number" || typeof claims.exp !== "number")
    return "has no iat or exp";
  if (claims.exp - claims.iat > expected.maxLifetime)
    return `lives longer than ${expected.maxLifetime} seconds`;
  return undefined;
}

/** The claims an auth token is minted with besides its own (#auth-token). */
export interface AuthGrant {
  aud: string;
  sub: string;
  scope?: string;
  account?: string;
  r3_uri?: string;
  r3_s256?: string;
  budget?: Budget;
}

const COPIED = ["scope", "account", "r3_uri", "r3_s256"] as const;

/** An auth token's grant for `aud`, with the claims it copies from the resource token. */
export function authGrant(
  rt: JWTPayload,
  aud: string,
  budget?: Budget,
): AuthGrant {
  const grant: AuthGrant = { aud, sub: String(rt.sub) };
  for (const claim of COPIED) {
    const value = rt[claim];
    if (typeof value === "string") grant[claim] = value;
  }
  if (budget) grant.budget = budget;
  return grant;
}
