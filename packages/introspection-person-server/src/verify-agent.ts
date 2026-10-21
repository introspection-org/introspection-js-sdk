/** Who is asking: the agent behind a signed request, and the person it acts for. */
import { verifyToken, AAuthTokenError } from "@aauth/resource";
import { verify } from "@hellocoop/httpsig";
import { decodeJwt } from "jose";

import {
  type Context,
  readBody,
  signatureError,
  tenantOf,
  trim,
} from "./context.js";
import { AAuthError } from "./errors.js";
import type { Agent, Person } from "./types.js";

export type AgentVerifier = ReturnType<typeof createAgentVerifier>;

export function createAgentVerifier({
  options,
  issuer,
  base,
  store,
  fetchLike,
  now,
  tenantFor,
  trusted,
}: Context) {
  // #region verify-agent
  /** The request's signature, and the agent token it presents, from a trusted agent provider. */
  async function verifyAgent(
    request: Request,
    body: string | undefined,
    path: string,
  ): Promise<Agent> {
    const signed = await verify(
      {
        method: request.method,
        // As the agent addressed it: this identifier and the route's path, whatever routed it here.
        authority: new URL(issuer).host,
        path: `${base}${path}`,
        headers: request.headers,
        ...(body ? { body } : {}),
      },
      { requireContentDigest: true, supportedAlgorithms: ["Ed25519", "ES256"] },
    );
    if (!signed.verified)
      throw signatureError(
        signed.signatureError?.error ?? "invalid_signature",
        signed.error ?? "signature does not verify",
      );
    if (signed.keyType !== "jwt" || !signed.jwt)
      throw signatureError("unsupported_scheme", "sign with sig=jwt");
    const claims = (() => {
      try {
        return decodeJwt(signed.jwt.raw);
      } catch {
        throw signatureError("invalid_jwt", "not a JWT");
      }
    })();
    const provider = trim(String(claims.iss ?? ""));
    if (!trusted(provider))
      throw signatureError("invalid_jwt", `${provider} is not trusted here`);
    const token = await verifyToken({
      jwt: signed.jwt.raw,
      httpSignatureThumbprint: signed.thumbprint,
      resource: issuer,
      accept: ["agent"],
      fetch: fetchLike,
      now: now(),
    }).catch((err: Error) => {
      const code = err instanceof AAuthTokenError ? err.code : "invalid_jwt";
      throw signatureError(
        code === "token_expired" ? "expired_jwt" : "invalid_jwt",
        err.message,
      );
    });
    if (token.type !== "agent")
      throw signatureError("invalid_jwt", "present an agent token");
    if (token.ps !== undefined && trim(token.ps) !== issuer)
      throw new AAuthError(
        403,
        "invalid_request",
        "this agent's Person Server is another",
      );
    return {
      id: token.sub,
      provider,
      jkt: signed.thumbprint,
      jwk: token.cnf.jwk,
      exp: token.exp,
    };
  }

  /** A signed request's verified agent and its JSON body. */
  async function readSigned(
    request: Request,
    path: string,
  ): Promise<{ agent: Agent; params: Record<string, unknown> }> {
    const body = await request.text();
    const agent = await verifyAgent(request, body, path);
    return { agent, params: readBody(body) };
  }

  /** The tenant a request names, and the person its agent acts for there. */
  async function requester(
    agent: Agent,
    params: Record<string, unknown>,
  ): Promise<{ tenant: string; person: Person }> {
    const named = tenantOf(params);
    const tenant = tenantFor(named);
    const person = await personFor(tenant, named, agent, params.login_hint);
    return { tenant, person };
  }

  /**
   * The person the agent acts for. Each agent key is bound to the first person
   * it names. Tokens carry the directory's tenant, else the one the agent named.
   */
  async function personFor(
    tenant: string,
    named: string | undefined,
    agent: Agent,
    loginHint: unknown,
  ): Promise<Person> {
    if (typeof loginHint !== "string" || !loginHint) {
      const bound = await store.binding(tenant, agent.jkt);
      if (!bound)
        throw new AAuthError(
          400,
          "invalid_request",
          "name the person: login_hint",
        );
      return bound;
    }
    const hinted = await options.directory.person(loginHint, tenant);
    if (!hinted)
      throw new AAuthError(
        400,
        "invalid_request",
        "not someone this Person Server speaks for",
      );
    // The directory's tenant is the person's; a request cannot move them.
    if (hinted.tenant && hinted.tenant !== tenant)
      throw new AAuthError(
        403,
        "invalid_request",
        "this person is not in that tenant",
      );
    const person =
      hinted.tenant || !named ? hinted : { ...hinted, tenant: named };
    const bound = await store.bind(tenant, agent.jkt, person);
    if (bound.id !== person.id)
      throw new AAuthError(
        403,
        "invalid_request",
        "this agent acts for another person",
      );
    return person;
  }
  // #endregion

  return { verifyAgent, readSigned, requester };
}
