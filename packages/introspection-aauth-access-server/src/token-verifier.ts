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
import {
  type FetchLike,
  InvalidRequest,
  InvalidToken,
  MAX_TOKEN_LIFETIME,
  tokenProblem,
  trimIdentifier,
} from "@introspection-sdk/aauth-protocol";
import {
  type JWTPayload,
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
} from "jose";

/** A JWT's header and claims, unverified; anything else is an invalid token. */
function decode(token: string, parameter: string) {
  try {
    return { header: decodeProtectedHeader(token), claims: decodeJwt(token) };
  } catch {
    throw new InvalidToken(parameter, "not a JWT");
  }
}

/** The name of every check a verified presented token fails, against the resource token that names it. */
function presentedFailures(
  presented: VerifiedToken,
  rt: JWTPayload,
  ps: string,
): string[] {
  const claims = presented.claims;
  const checks: Record<string, boolean> = {
    jti: claims.jti !== rt.presented_jti,
    ps:
      trimIdentifier(
        presented.type === "auth" ? presented.ps : presented.iss,
      ) !== ps,
    sub: claims.sub !== rt.sub,
    mission_s256: claims.mission_s256 !== rt.mission_s256,
    tenant: claims.tenant !== rt.tenant,
  };
  return Object.keys(checks).filter((name) => checks[name]);
}

export class TokenVerifier {
  constructor(
    private readonly issuer: string,
    private readonly resources: readonly string[],
    private readonly agentProviders: readonly string[],
    private readonly fetch: FetchLike,
    private readonly now: () => number,
  ) {}

  /** #resource-token-verification, at an Access Server: `ps` is the signer. */
  async resourceToken(token: string, ps: string): Promise<JWTPayload> {
    const { header, claims } = decode(token, "resource");
    if (header.typ !== "aa-resource+jwt")
      throw new InvalidToken("resource", "not a resource token");
    const resource = trimIdentifier(String(claims.iss ?? ""));
    // Checked before verifying, since verifying fetches the issuer's keys.
    if (!this.resources.includes(resource))
      throw new InvalidToken(
        "resource",
        `this Access Server does not decide for ${resource}`,
      );
    let rt: JWTPayload;
    try {
      const keys = await discoverJwks({
        iss: resource,
        dwk: "aauth-resource.json",
        fetch: this.fetch,
      });
      ({ payload: rt } = await jwtVerify(token, createLocalJWKSet(keys), {
        typ: "aa-resource+jwt",
        issuer: String(claims.iss),
        algorithms: ["Ed25519", "ES256"],
        currentDate: new Date(this.now() * 1000),
      }));
    } catch (err) {
      throw new InvalidToken("resource", (err as Error).message, {
        expired: (err as { code?: string }).code === "ERR_JWT_EXPIRED",
      });
    }
    const shape = tokenProblem(rt, { dwk: "aauth-resource.json" });
    if (shape) throw new InvalidToken("resource", `it ${shape}`);
    if (typeof rt.aud !== "string" || trimIdentifier(rt.aud) !== this.issuer)
      throw new InvalidToken("resource", "its aud is not this Access Server");
    if (typeof rt.ps !== "string" || trimIdentifier(rt.ps) !== ps)
      throw new InvalidToken(
        "resource",
        "its ps is not the Person Server that sent it",
      );
    for (const claim of ["sub", "presented_jti", "agent_jkt"])
      if (typeof rt[claim] !== "string" || !rt[claim])
        throw new InvalidToken("resource", `${claim} is required`);
    return rt;
  }

  /** The agent's token, from a trusted agent provider, bound to the key the resource token names. */
  async agentToken(
    token: string,
    rt: JWTPayload,
    ps: string,
  ): Promise<Extract<VerifiedToken, { type: "agent" }>> {
    const provider = trimIdentifier(
      String(decode(token, "agent").claims.iss ?? ""),
    );
    if (!this.agentProviders.includes(provider))
      throw new InvalidRequest(
        `agent_token: ${provider} is not an agent provider this Access Server trusts`,
      );
    const agent = await verifyToken({
      jwt: token,
      httpSignatureThumbprint: String(rt.agent_jkt),
      resource: this.issuer,
      accept: ["agent"],
      fetch: this.fetch,
      now: this.now(),
    }).catch((err: Error) => {
      if (err instanceof AAuthTokenError && err.code === "key_binding_failed")
        throw new InvalidToken(
          "resource",
          "agent_jkt is not the agent token's key",
        );
      throw new InvalidRequest(`agent_token: ${err.message}`);
    });
    if (agent.type !== "agent")
      throw new InvalidRequest("agent_token is not one");
    const shape = tokenProblem(agent.claims, {});
    if (shape) throw new InvalidRequest(`agent_token ${shape}`);
    if (agent.ps !== undefined && trimIdentifier(agent.ps) !== ps)
      throw new InvalidRequest("agent_token names another Person Server");
    return agent;
  }

  /**
   * The token the resource saw (step 3 of #resource-token-verification): a
   * person token from the Person Server that sent the request, or an auth
   * token this Access Server issued for it, for the resource and the agent's
   * key, and matching the resource token exactly.
   */
  async presentedToken(
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
      throw new InvalidToken(
        "presented",
        "neither a person token nor an auth token",
      );
    if (
      trimIdentifier(String(claims.iss ?? "")) !==
      (kind === "person" ? ps : this.issuer)
    )
      throw new InvalidToken(
        "presented",
        "issued by neither the Person Server that sent it nor this Access Server",
      );
    const presented = await verifyToken({
      jwt: token,
      httpSignatureThumbprint: String(rt.agent_jkt),
      resource: String(rt.iss),
      accept: [kind],
      fetch: this.fetch,
      now: this.now(),
    }).catch((err: Error) => {
      throw new InvalidToken("presented", err.message, {
        expired: err instanceof AAuthTokenError && err.code === "token_expired",
      });
    });
    const shape = tokenProblem(presented.claims, {
      maxLifetime: MAX_TOKEN_LIFETIME,
    });
    if (shape) throw new InvalidToken("presented", `it ${shape}`);
    const wrong = presentedFailures(presented, rt, ps);
    if (wrong.length)
      throw new InvalidToken(
        "resource",
        `it does not match the presented token: ${wrong.join(", ")}`,
      );
    return presented;
  }
}
