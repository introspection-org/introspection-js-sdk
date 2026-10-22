/**
 * What a Person Server verifies of what an agent sends: its signed request and
 * the agent token it presents, the token it presented to a resource, and the
 * resource token the resource answered with.
 */
import { AAuthTokenError, discoverJwks, verifyToken } from "@aauth/resource";
import {
  type FetchLike,
  InvalidRequest,
  InvalidToken,
  MAX_TOKEN_LIFETIME,
  type Signer,
  tokenProblem,
  trimIdentifier,
  Unauthorized,
  verifySignature,
} from "@introspection-sdk/aauth-protocol";
import { type JWTPayload, createLocalJWKSet, decodeJwt, jwtVerify } from "jose";

import { signsWithJwt } from "./requests.js";
import type { Agent } from "./types.js";

const DWK = "aauth-person.json";

export class TokenVerifier {
  constructor(
    private readonly issuer: string,
    /** Where its routes live under the issuer. */
    private readonly base: string,
    private readonly signer: Signer,
    private readonly trusted: (issuer: string) => boolean,
    private readonly fetch: FetchLike,
    private readonly now: () => number,
  ) {}

  /** The request's signature, and the agent token it presents, from a trusted agent provider. */
  async agent(
    request: Request,
    body: string | undefined,
    path: string,
  ): Promise<{ agent: Agent; agentToken: string }> {
    // Checked before verifying: verifying a `jwks_uri` or other scheme fetches keys from where the
    // header says, and an agent only ever signs with `sig=jwt`.
    if (!signsWithJwt(request.headers.get("signature-key")))
      throw Unauthorized.signature("unsupported_scheme", "sign with sig=jwt");
    const signed = await verifySignature(
      request,
      body,
      new URL(this.issuer).host,
      `${this.base}${path}`,
    );
    if (signed.keyType !== "jwt" || !signed.jwt)
      throw Unauthorized.signature("unsupported_scheme", "sign with sig=jwt");
    const raw = signed.jwt.raw;
    let claims: JWTPayload;
    try {
      claims = decodeJwt(raw);
    } catch {
      throw Unauthorized.signature("invalid_jwt", "not a JWT");
    }
    const provider = trimIdentifier(String(claims.iss ?? ""));
    if (!this.trusted(provider))
      throw Unauthorized.signature(
        "invalid_jwt",
        `${provider} is not trusted here`,
      );
    const token = await verifyToken({
      jwt: raw,
      httpSignatureThumbprint: signed.thumbprint,
      resource: this.issuer,
      accept: ["agent"],
      fetch: this.fetch,
      now: this.now(),
    }).catch((err: Error) => {
      const code = err instanceof AAuthTokenError ? err.code : "invalid_jwt";
      throw Unauthorized.signature(
        code === "token_expired" ? "expired_jwt" : "invalid_jwt",
        err.message,
      );
    });
    if (token.type !== "agent")
      throw Unauthorized.signature("invalid_jwt", "present an agent token");
    const shape = tokenProblem(token.claims, {});
    if (shape)
      throw Unauthorized.signature("invalid_jwt", `the agent token ${shape}`);
    if (token.ps !== undefined && trimIdentifier(token.ps) !== this.issuer)
      throw new InvalidRequest("this agent's Person Server is another", {
        status: 403,
      });
    return {
      agent: {
        id: token.sub,
        provider,
        jkt: signed.thumbprint,
        jwk: token.cnf.jwk,
        exp: token.exp,
      },
      agentToken: raw,
    };
  }

  /** The presented token: a live person or auth token this Person Server issued. */
  presented(token: string): Promise<JWTPayload> {
    return jwtVerify(token, createLocalJWKSet(this.signer.jwks), {
      issuer: this.issuer,
      currentDate: new Date(this.now() * 1000),
    })
      .then(({ payload, protectedHeader }) => {
        const shape =
          protectedHeader.typ === "aa-person+jwt" ||
          protectedHeader.typ === "aa-auth+jwt"
            ? tokenProblem(payload, {
                dwk: DWK,
                maxLifetime: MAX_TOKEN_LIFETIME,
              })
            : "is neither a person token nor an auth token";
        if (shape) throw new Error(shape);
        return payload;
      })
      .catch((err: Error) => {
        throw new InvalidToken(
          "presented",
          "not a live token this Person Server issued",
          { expired: err.name === "JWTExpired" },
        );
      });
  }

  /** A resource token, signed by `resource`'s keys, whose shape is a resource token's. */
  async resource(token: string, resource: string): Promise<JWTPayload> {
    const rt = await discoverJwks({
      iss: resource,
      dwk: "aauth-resource.json",
      fetch: this.fetch,
    })
      .then((jwks) =>
        jwtVerify(token, createLocalJWKSet(jwks), {
          typ: "aa-resource+jwt",
          issuer: resource,
          algorithms: ["Ed25519", "ES256"],
          currentDate: new Date(this.now() * 1000),
        }),
      )
      .then((r) => r.payload)
      .catch((err: Error) => {
        throw new InvalidToken("resource", err.message);
      });
    const shape = tokenProblem(rt, { dwk: "aauth-resource.json" });
    if (shape) throw new InvalidToken("resource", `it ${shape}`);
    return rt;
  }
}
