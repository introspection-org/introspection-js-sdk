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
  isJsonObject as isObject,
  MAX_TOKEN_LIFETIME,
  parseBudget,
  sameScale,
  type Signer,
  tokenProblem,
  trimIdentifier,
} from "@introspection-sdk/aauth-protocol";

import type { Budget, Federation } from "./types.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const ACCESS_DWK = "aauth-access.json";
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
      /** How long it asked to be left, from its `Retry-After`. */
      retry_after?: number;
    }
  | {
      /** It was too busy to take the request (`429` or `503`): send it again later. */
      status: "busy";
      retry_after?: number;
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

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/** A string member of a JSON object, or undefined. */
function member(body: unknown, name: string): string | undefined {
  const value = isObject(body) ? body[name] : undefined;
  return typeof value === "string" ? value : undefined;
}

const isJwks = (body: unknown): body is { keys: JWK[] } =>
  isObject(body) &&
  Array.isArray(body.keys) &&
  body.keys.every((key) => isObject(key));

/** `Retry-After` in seconds, when it is a number of them. */
function retryAfter(response: Response): number | undefined {
  const seconds = Number(response.headers.get("retry-after") ?? "");
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : undefined;
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
  const issuer = member(doc, "issuer");
  const jwks_uri = member(doc, "jwks_uri");
  const auth_token_endpoint = member(doc, "auth_token_endpoint");
  if (
    issuer === undefined ||
    trimIdentifier(issuer) !== trimIdentifier(accessServer) ||
    !jwks_uri?.startsWith("https://") ||
    !auth_token_endpoint?.startsWith("https://")
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
  const agent = decodeJwt(federation.agent_token);
  let claims;
  try {
    const keys: unknown = await ctx
      .fetch(metadata.jwks_uri)
      .then((r) => r.json());
    if (!isJwks(keys)) throw new Error("its jwks_uri is not a JWK Set");
    claims = (
      await jwtVerify(token, createLocalJWKSet(keys), {
        typ: "aa-auth+jwt",
        algorithms: ["Ed25519", "ES256"],
        currentDate: new Date(ctx.now() * 1000),
      })
    ).payload;
  } catch (err) {
    throw unreachable(
      `its auth token does not verify: ${(err as Error).message}`,
    );
  }
  const cnf =
    isObject(claims.cnf) && isObject(claims.cnf.jwk)
      ? claims.cnf.jwk
      : undefined;
  const granted = scopes(claims.scope);
  const asked = scopes(rt.scope);
  const budget = readBudget(claims.budget);
  const shape = tokenProblem(claims, {
    dwk: ACCESS_DWK,
    maxLifetime: MAX_TOKEN_LIFETIME,
  });
  if (shape) throw unreachable(`its auth token ${shape}`);
  const same = (claim: string, expected: unknown) =>
    typeof claims[claim] === "string" &&
    typeof expected === "string" &&
    trimIdentifier(String(claims[claim])) === trimIdentifier(expected);
  const notAfter = Math.min(Number(presented.exp), Number(agent.exp));
  const problems = [
    !same("iss", metadata.issuer) && "iss",
    !same("aud", rt.iss) && "aud",
    !same("ps", ctx.issuer) && "ps",
    claims.sub !== rt.sub && "sub",
    claims.mission_s256 !== rt.mission_s256 && "mission_s256",
    ...(["account", "r3_uri", "r3_s256"] as const).map(
      (claim) =>
        rt[claim] !== undefined && claims[claim] !== rt[claim] && claim,
    ),
    [...granted].some((s) => !asked.has(s)) && "scope",
    !(Number(claims.exp) <= notAfter) && "exp",
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

const retrying = (response: Response) => {
  const seconds = retryAfter(response);
  return seconds === undefined ? {} : { retry_after: seconds };
};

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
    const auth_token = member(await readJson(response), "auth_token");
    if (auth_token === undefined)
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
      ...retrying(response),
    };
  }
  if (response.status === 402)
    throw refused(
      "the Access Server asks for payment, which this Person Server does not make",
    );
  // #deferred-responses: a busy AS is asked again later, at the same Location or with the same request.
  if (response.status === 429 || response.status === 503)
    return federation.location
      ? {
          status: "pending",
          location: requested,
          requirement: federation.requirement ?? "requirement=approval",
          ...retrying(response),
        }
      : { status: "busy", ...retrying(response) };
  const body = await readJson(response);
  const error = member(body, "error");
  const detail = member(body, "detail");
  if (response.status >= 400 && response.status < 500 && error !== undefined)
    throw new AAuthError(
      response.status,
      error,
      `the Access Server refused: ${detail ?? error}`,
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
