/**
 * What an Access Server checks of a Person Server's token request
 * (#ps-to-as-token-request): the resource token is for it and from a resource
 * it decides for, the agent token is from a trusted agent provider and binds
 * the key the resource token names, and the presented token is the one the
 * resource saw, from the Person Server that sent the request.
 */
import {
  AAuthTokenError,
  type VerifiedToken,
  discoverJwks,
  verifyToken,
} from "@aauth/resource";
import { AAuthError } from "@introspection-sdk/person-server";
import {
  type JWTPayload,
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
} from "jose";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** What an Access Server verifies with. */
export interface Verifier {
  issuer: string;
  resources: readonly string[];
  agentProviders: readonly string[];
  fetch: FetchLike;
  now: () => number;
}

const tokenError = (parameter: string, detail: string, expired = false) =>
  new AAuthError(
    400,
    `${expired ? "expired" : "invalid"}_${parameter}_token`,
    detail,
  );

/** A JWT's header and claims, unverified; anything else is an invalid token. */
function decode(token: string, parameter: string) {
  try {
    return { header: decodeProtectedHeader(token), claims: decodeJwt(token) };
  } catch {
    throw tokenError(parameter, "not a JWT");
  }
}

/** #resource-token-verification, at an Access Server: `ps` is the signer. */
export async function verifyResourceToken(
  verifier: Verifier,
  token: string,
  ps: string,
): Promise<JWTPayload> {
  const { header, claims } = decode(token, "resource");
  if (header.typ !== "aa-resource+jwt")
    throw tokenError("resource", "not a resource token");
  const resource = String(claims.iss ?? "");
  // Checked before verifying, since verifying fetches the issuer's keys.
  if (!verifier.resources.includes(resource))
    throw tokenError(
      "resource",
      `this Access Server does not decide for ${resource}`,
    );
  let rt: JWTPayload;
  try {
    const keys = await discoverJwks({
      iss: resource,
      dwk: "aauth-resource.json",
      fetch: verifier.fetch,
    });
    ({ payload: rt } = await jwtVerify(token, createLocalJWKSet(keys), {
      typ: "aa-resource+jwt",
      issuer: resource,
      algorithms: ["Ed25519", "ES256"],
      currentDate: new Date(verifier.now() * 1000),
    }));
  } catch (err) {
    throw tokenError(
      "resource",
      (err as Error).message,
      (err as { code?: string }).code === "ERR_JWT_EXPIRED",
    );
  }
  if (rt.dwk !== "aauth-resource.json")
    throw tokenError("resource", "dwk is not aauth-resource.json");
  if (rt.aud !== verifier.issuer)
    throw tokenError("resource", "its aud is not this Access Server");
  if (rt.ps !== ps)
    throw tokenError(
      "resource",
      "its ps is not the Person Server that sent it",
    );
  for (const claim of ["sub", "presented_jti", "agent_jkt"])
    if (typeof rt[claim] !== "string" || !rt[claim])
      throw tokenError("resource", `${claim} is required`);
  return rt;
}

/** The agent's token, from a trusted agent provider, bound to the key the resource token names. */
export async function verifyAgentToken(
  verifier: Verifier,
  token: string,
  rt: JWTPayload,
  ps: string,
): Promise<Extract<VerifiedToken, { type: "agent" }>> {
  const provider = String(decode(token, "agent").claims.iss ?? "");
  if (!verifier.agentProviders.includes(provider))
    throw new AAuthError(
      400,
      "invalid_request",
      `agent_token: ${provider} is not an agent provider this Access Server trusts`,
    );
  const agent = await verifyToken({
    jwt: token,
    httpSignatureThumbprint: String(rt.agent_jkt),
    resource: verifier.issuer,
    accept: ["agent"],
    fetch: verifier.fetch,
    now: verifier.now(),
  }).catch((err: Error) => {
    if (err instanceof AAuthTokenError && err.code === "key_binding_failed")
      throw tokenError("resource", "agent_jkt is not the agent token's key");
    throw new AAuthError(400, "invalid_request", `agent_token: ${err.message}`);
  });
  if (agent.type !== "agent")
    throw new AAuthError(400, "invalid_request", "agent_token is not one");
  if (agent.ps !== undefined && agent.ps !== ps)
    throw new AAuthError(
      400,
      "invalid_request",
      "agent_token names another Person Server",
    );
  return agent;
}

/**
 * The token the resource saw (step 3 of #resource-token-verification): a person
 * token from the Person Server that sent the request, or an auth token this
 * Access Server issued for it, for the resource and the agent's key, and
 * matching the resource token exactly.
 */
export async function verifyPresentedToken(
  verifier: Verifier,
  token: string,
  rt: JWTPayload,
  ps: string,
): Promise<VerifiedToken> {
  const { header, claims } = decode(token, "presented");
  const kind =
    header.typ === "aa-person+jwt"
      ? "person"
      : header.typ === "aa-auth+jwt"
        ? "auth"
        : undefined;
  if (!kind)
    throw tokenError("presented", "neither a person token nor an auth token");
  if (claims.iss !== (kind === "person" ? ps : verifier.issuer))
    throw tokenError(
      "presented",
      "issued by neither the Person Server that sent it nor this Access Server",
    );
  const presented = await verifyToken({
    jwt: token,
    httpSignatureThumbprint: String(rt.agent_jkt),
    resource: String(rt.iss),
    accept: [kind],
    fetch: verifier.fetch,
    now: verifier.now(),
  }).catch((err: Error) => {
    throw tokenError(
      "presented",
      err.message,
      err instanceof AAuthTokenError && err.code === "token_expired",
    );
  });
  const verified = presented.claims;
  if (
    verified.jti !== rt.presented_jti ||
    (presented.type === "auth" ? presented.ps : presented.iss) !== rt.ps ||
    verified.sub !== rt.sub ||
    verified.mission_s256 !== rt.mission_s256 ||
    verified.tenant !== rt.tenant
  )
    throw tokenError("resource", "it does not match the presented token");
  return presented;
}
