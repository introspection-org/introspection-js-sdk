/**
 * #auth-token-delivery, and the budget check of draft-hardt-aauth-budgets
 * #as-token-endpoint: the auth token an Access Server delivers is checked
 * before the agent gets it, against the request the Person Server sent.
 */
import {
  type FetchLike,
  isJsonObject,
  MAX_TOKEN_LIFETIME,
  parseBudget,
  sameScale,
  tokenProblem,
  trimIdentifier,
} from "@introspection-sdk/aauth-protocol";
import {
  type JWK,
  type JWTPayload,
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeJwt,
  jwtVerify,
} from "jose";

import type { AccessMetadata } from "./access-server-client.js";
import { type Budget, type Federation, Outcome } from "./types.js";

const ACCESS_DWK = "aauth-access.json";

/** What a delivered auth token is checked against. */
export interface Delivery {
  federation: Federation;
  /** The agent's key, which the auth token must bind. */
  agentJkt: string;
  metadata: AccessMetadata;
  /** This Person Server. */
  ps: string;
  fetch: FetchLike;
  now: number;
}

const isJwks = (body: unknown): body is { keys: JWK[] } =>
  isJsonObject(body) &&
  Array.isArray(body.keys) &&
  body.keys.every((key) => isJsonObject(key));

const scopes = (value: unknown) =>
  new Set(typeof value === "string" ? value.split(" ").filter(Boolean) : []);

/** The AS's budget claim, or `null` when it is not a budget. */
function readBudget(value: unknown): Budget | undefined | null {
  try {
    return parseBudget(value);
  } catch {
    return null;
  }
}

/** Whether the AS granted no more than was sent (draft-hardt-aauth-budgets #as-token-endpoint). */
const withinSent = (
  granted: Budget | undefined | null,
  sent: Budget | undefined,
): boolean =>
  granted === null
    ? false
    : !granted || !sent
      ? !granted && !sent
      : sameScale(granted, sent) && granted.amount <= sent.amount;

/** The name of every check a verified auth token fails, against the request that asked for it. */
async function deliveryFailures(
  claims: JWTPayload,
  delivery: Delivery,
): Promise<string[]> {
  const { federation, metadata } = delivery;
  const rt = decodeJwt(federation.resource_token);
  const presented = decodeJwt(federation.presented_token);
  const agent = decodeJwt(federation.agent_token);
  const same = (claim: string, expected: unknown) =>
    typeof claims[claim] === "string" &&
    typeof expected === "string" &&
    trimIdentifier(String(claims[claim])) === trimIdentifier(expected);
  const asked = scopes(rt.scope);
  const cnf =
    isJsonObject(claims.cnf) && isJsonObject(claims.cnf.jwk)
      ? claims.cnf.jwk
      : undefined;
  const checks: Record<string, boolean> = {
    iss: !same("iss", metadata.issuer),
    aud: !same("aud", rt.iss),
    ps: !same("ps", delivery.ps),
    sub: claims.sub !== rt.sub,
    mission_s256: claims.mission_s256 !== rt.mission_s256,
    tenant: rt.tenant !== undefined && claims.tenant !== rt.tenant,
    account: rt.account !== undefined && claims.account !== rt.account,
    r3_uri: rt.r3_uri !== undefined && claims.r3_uri !== rt.r3_uri,
    r3_s256: rt.r3_s256 !== undefined && claims.r3_s256 !== rt.r3_s256,
    scope: [...scopes(claims.scope)].some((s) => !asked.has(s)),
    exp: !(
      Number(claims.exp) <= Math.min(Number(presented.exp), Number(agent.exp))
    ),
    budget: !withinSent(readBudget(claims.budget), federation.budget),
    cnf: !cnf || (await calculateJwkThumbprint(cnf)) !== delivery.agentJkt,
  };
  return Object.keys(checks).filter((name) => checks[name]);
}

/** The delivered auth token, issued, once it verifies and passes every check; unreachable otherwise. */
export async function checkDelivered(
  token: string,
  delivery: Delivery,
): Promise<Outcome> {
  let claims: JWTPayload;
  try {
    const keys: unknown = await delivery
      .fetch(delivery.metadata.jwks_uri)
      .then((r) => r.json());
    if (!isJwks(keys)) throw new Error("its jwks_uri is not a JWK Set");
    claims = (
      await jwtVerify(token, createLocalJWKSet(keys), {
        typ: "aa-auth+jwt",
        algorithms: ["Ed25519", "ES256"],
        currentDate: new Date(delivery.now * 1000),
      })
    ).payload;
  } catch (err) {
    return Outcome.unreachable(
      `its auth token does not verify: ${(err as Error).message}`,
    );
  }
  const shape = tokenProblem(claims, {
    dwk: ACCESS_DWK,
    maxLifetime: MAX_TOKEN_LIFETIME,
  });
  if (shape) return Outcome.unreachable(`its auth token ${shape}`);
  const wrong = await deliveryFailures(claims, delivery);
  if (wrong.length)
    return Outcome.unreachable(
      `its auth token has the wrong ${wrong.join(", ")}`,
    );
  const granted = readBudget(claims.budget);
  return new Outcome("issued", {
    auth_token: token,
    expires_in: Number(claims.exp) - delivery.now,
    ...(granted ? { granted } : {}),
  });
}
