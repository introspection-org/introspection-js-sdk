/**
 * Four-party access (draft -11 #access-server-federation): a resource token
 * whose `aud` is the resource's own Access Server is redeemed there. The
 * Person Server sends the AS the three tokens, signed with its own key, and
 * follows the deferred response loop until the AS issues or refuses.
 */
import {
  UnsupportedRequirementError,
  parseRequirementHeader,
} from "@aauth/resource";
import { fetch as signedFetch } from "@hellocoop/httpsig";
import {
  type JWK,
  calculateJwkThumbprint,
  createLocalJWKSet,
  decodeJwt,
  jwtVerify,
} from "jose";
import {
  AAuthError,
  parseBudget,
  sameScale,
  type Signer,
} from "@introspection-sdk/aauth-protocol";

import type { Budget, Federation } from "./types.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const ACCESS_DWK = "aauth-access.json";
const MAX_AUTH_TOKEN_LIFETIME = 60 * 60;
/** Requirements an Access Server may wait on that this Person Server relays to the agent. */
const SERVED = new Set(["approval", "interaction"]);
/** Requirements it would answer for the person, which it does not yet. */
const DEFERRED = new Set(["claims", "clarification"]);

/** What a Person Server federates as. */
export interface FederationContext {
  issuer: string;
  signer: Signer;
  fetch: FetchLike;
  now: () => number;
}

/** What the Access Server answered, once it answered with something the Person Server acts on. */
export type AccessOutcome =
  | {
      status: "issued";
      auth_token: string;
      expires_in: number;
      /** The budget the AS granted, no more than the one sent; spent in its place. */
      granted?: Budget;
    }
  | {
      status: "pending";
      location: string;
      /** Its `AAuth-Requirement`, relayed to the agent. */
      requirement: string;
    };

interface AccessMetadata {
  issuer: string;
  jwks_uri: string;
  auth_token_endpoint: string;
}

/** The Person Server could not get a verifiable answer from the AS. */
const unreachable = (detail: string) =>
  new AAuthError(502, "as_unreachable", detail);

const refused = (detail: string) => new AAuthError(403, "denied", detail);

async function readJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await response.json();
    return body && typeof body === "object"
      ? (body as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** `{aud}/.well-known/aauth-access.json`, for the AS a verified resource token names. */
async function accessMetadata(
  accessServer: string,
  ctx: FederationContext,
): Promise<AccessMetadata> {
  const url = `${accessServer}/.well-known/${ACCESS_DWK}`;
  const response = await ctx.fetch(url).catch((err: Error) => {
    throw unreachable(`${url}: ${err.message}`);
  });
  if (!response.ok) throw unreachable(`${url} answered ${response.status}`);
  const doc = await readJson(response);
  const https = (value: unknown): value is string =>
    typeof value === "string" && value.startsWith("https://");
  const { issuer, jwks_uri, auth_token_endpoint } = doc;
  if (
    issuer !== accessServer ||
    !https(jwks_uri) ||
    !https(auth_token_endpoint)
  )
    throw unreachable(
      `${url} is not this Access Server's metadata, with https endpoints`,
    );
  return { issuer: accessServer, jwks_uri, auth_token_endpoint };
}

/** A request signed with this Person Server's key, `sig=jwks_uri`. */
async function send(
  ctx: FederationContext,
  url: string,
  body?: string,
): Promise<Response> {
  const method = body === undefined ? "GET" : "POST";
  const { headers } = await signedFetch(url, {
    method,
    ...(body === undefined
      ? {}
      : {
          body,
          headers: { "Content-Type": "application/json" },
          contentDigest: "require" as const,
        }),
    signingKey: ctx.signer.privateJwk as JsonWebKey,
    signatureKey: {
      type: "jwks_uri",
      id: ctx.issuer,
      kid: ctx.signer.kid,
      dwk: "aauth-person.json",
    },
    dryRun: true,
  });
  return ctx
    .fetch(url, { method, headers, ...(body === undefined ? {} : { body }) })
    .catch((err: Error) => {
      throw unreachable(`${url}: ${err.message}`);
    });
}

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
  granted: Budget | undefined,
  sent: Budget | undefined,
): boolean =>
  !granted || !sent
    ? !granted && !sent
    : sameScale(granted, sent) && granted.amount <= sent.amount;

/**
 * #auth-token-delivery, and the budget check of draft-hardt-aauth-budgets
 * #as-token-endpoint: the AS's auth token, checked before the agent gets it.
 */
async function verifyDelivered(
  token: string,
  federation: Federation,
  agentJkt: string,
  metadata: AccessMetadata,
  ctx: FederationContext,
): Promise<{ expires_in: number; granted?: Budget }> {
  const rt = decodeJwt(federation.resource_token);
  const presented = decodeJwt(federation.presented_token);
  let claims;
  try {
    const keys = await ctx.fetch(metadata.jwks_uri).then((r) => r.json());
    claims = (
      await jwtVerify(token, createLocalJWKSet(keys as { keys: JWK[] }), {
        typ: "aa-auth+jwt",
        issuer: metadata.issuer,
        audience: String(rt.iss),
        algorithms: ["Ed25519", "ES256"],
        currentDate: new Date(ctx.now() * 1000),
      })
    ).payload;
  } catch (err) {
    throw unreachable(
      `its auth token does not verify: ${(err as Error).message}`,
    );
  }
  const cnf = (claims.cnf as { jwk?: JWK } | undefined)?.jwk;
  const granted = scopes(claims.scope);
  const asked = scopes(rt.scope);
  const budget = readBudget(claims.budget);
  const problems = [
    claims.dwk !== ACCESS_DWK && "dwk",
    claims.ps !== ctx.issuer && "ps",
    claims.sub !== rt.sub && "sub",
    claims.mission_s256 !== rt.mission_s256 && "mission_s256",
    [...granted].some((s) => !asked.has(s)) && "scope",
    (typeof claims.exp !== "number" || claims.exp > Number(presented.exp)) &&
      "exp",
    (typeof claims.iat !== "number" ||
      Number(claims.exp) - claims.iat > MAX_AUTH_TOKEN_LIFETIME) &&
      "lifetime",
    (budget === null || !withinSent(budget ?? undefined, federation.budget)) &&
      "budget",
    (!cnf || (await calculateJwkThumbprint(cnf)) !== agentJkt) && "cnf",
  ].filter(Boolean);
  if (problems.length)
    throw unreachable(`its auth token has the wrong ${problems.join(", ")}`);
  return {
    expires_in: Number(claims.exp) - ctx.now(),
    ...(budget ? { granted: budget } : {}),
  };
}

/** Act on the AS's answer: an auth token, a wait, or a refusal relayed with its reason. */
async function outcome(
  response: Response,
  requested: string,
  federation: Federation,
  agentJkt: string,
  metadata: AccessMetadata,
  ctx: FederationContext,
): Promise<AccessOutcome> {
  if (response.status === 200) {
    const { auth_token } = await readJson(response);
    if (typeof auth_token !== "string")
      throw unreachable("it answered 200 without an auth_token");
    const delivered = await verifyDelivered(
      auth_token,
      federation,
      agentJkt,
      metadata,
      ctx,
    );
    return { status: "issued", auth_token, ...delivered };
  }
  if (response.status === 202) {
    const header = response.headers.get("aauth-requirement");
    let requirement = "approval";
    try {
      if (header) requirement = parseRequirementHeader(header).requirement;
    } catch (err) {
      if (!(err instanceof UnsupportedRequirementError))
        throw unreachable(`its AAuth-Requirement is malformed`);
      requirement = err.value;
    }
    if (DEFERRED.has(requirement))
      throw refused(
        `the Access Server asks for requirement=${requirement}, not served here yet`,
      );
    const location = response.headers.get("location");
    const pending = location ? new URL(location, requested) : undefined;
    if (!pending || pending.origin !== new URL(federation.access_server).origin)
      throw unreachable("its pending Location is not on its own origin");
    return {
      status: "pending",
      location: pending.href,
      // An unrecognised requirement is polled through, and relayed as approval (#requirement-values).
      requirement:
        header && SERVED.has(requirement) ? header : "requirement=approval",
    };
  }
  if (response.status === 402)
    throw refused(
      "the Access Server asks for payment, which this Person Server does not make",
    );
  // #deferred-responses: a busy AS is polled again later, at the same Location.
  if (
    (response.status === 429 || response.status === 503) &&
    requested !== metadata.auth_token_endpoint
  )
    return {
      status: "pending",
      location: requested,
      requirement: federation.requirement ?? "requirement=approval",
    };
  const { error, detail } = await readJson(response);
  if (
    response.status >= 400 &&
    response.status < 500 &&
    typeof error === "string"
  )
    throw new AAuthError(
      response.status,
      error,
      `the Access Server refused: ${typeof detail === "string" ? detail : error}`,
    );
  throw unreachable(`it answered ${response.status}`);
}

/**
 * Ask the AS for an auth token (#ps-to-as-token-request), or, once it has
 * answered `202`, poll its `Location`. A refusal is thrown as the AS's own
 * error and status; a failure to get a verifiable answer as `as_unreachable`.
 */
export async function federate(
  federation: Federation,
  agentJkt: string,
  ctx: FederationContext,
): Promise<AccessOutcome> {
  const metadata = await accessMetadata(federation.access_server, ctx);
  const url = federation.location ?? metadata.auth_token_endpoint;
  const response = await send(
    ctx,
    url,
    federation.location
      ? undefined
      : JSON.stringify({
          resource_token: federation.resource_token,
          agent_token: federation.agent_token,
          presented_token: federation.presented_token,
          ...(federation.budget ? { budget: federation.budget } : {}),
        }),
  );
  return outcome(response, url, federation, agentJkt, metadata, ctx);
}
