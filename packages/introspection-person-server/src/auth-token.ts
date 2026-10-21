/** The auth token endpoint: verify the resource token, weigh the budget. */
import { verifyR3Hash, discoverJwks } from "@aauth/resource";
import { fetch as signedFetch } from "@hellocoop/httpsig";
import {
  type JWTPayload,
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
} from "jose";

import {
  type Context,
  DWK,
  readBudget,
  sameScale,
  tenantOf,
  trim,
} from "./context.js";
import { AAuthError } from "./errors.js";
import type { Asker } from "./ask.js";
import type { Missions } from "./missions.js";
import type { Tokens } from "./person-token.js";
import type { Agent } from "./types.js";
import type { AgentVerifier } from "./verify-agent.js";

export function createAuthTokenEndpoint(
  { issuer, store, signer, fetchLike, now, defaultTenant, tenantFor }: Context,
  {
    readSigned,
    liveMission,
    authToken,
    ask,
  }: Pick<AgentVerifier, "readSigned"> &
    Pick<Missions, "liveMission"> &
    Pick<Tokens, "authToken"> &
    Pick<Asker, "ask">,
) {
  // #region auth-token
  /** A resource token, verified against its issuer's keys, binding a token this Person Server issued. */
  async function verifyResourceToken(
    agent: Agent,
    params: Record<string, unknown>,
  ) {
    const { resource_token, presented_token } = params;
    if (
      typeof resource_token !== "string" ||
      typeof presented_token !== "string"
    )
      throw new AAuthError(
        400,
        "invalid_request",
        "resource_token and presented_token are required",
      );
    const invalid = (detail: string) =>
      new AAuthError(400, "invalid_resource_token", detail);
    const presented = await jwtVerify(
      presented_token,
      createLocalJWKSet(signer.jwks),
      { issuer },
    )
      .then((r) => r.payload)
      .catch((err: Error) => {
        throw new AAuthError(
          400,
          err.name === "JWTExpired"
            ? "expired_presented_token"
            : "invalid_presented_token",
          "not a live token this Person Server issued",
        );
      });
    let unverified: JWTPayload;
    try {
      if (decodeProtectedHeader(resource_token).typ !== "aa-resource+jwt")
        throw invalid("not a resource token");
      unverified = decodeJwt(resource_token);
    } catch (err) {
      if (err instanceof AAuthError) throw err;
      throw invalid("not a JWT");
    }
    const resource = trim(String(unverified.iss ?? ""));
    const tenant = tenantFor(tenantOf(params));
    // A token that carries no tenant was issued under the default.
    const tokenTenant =
      typeof presented.tenant === "string" ? presented.tenant : defaultTenant;
    if (tokenTenant !== tenant)
      throw invalid("tenant does not match the presented token");
    // The mission's approved resources are the only issuers whose keys are fetched.
    const mission =
      typeof unverified.mission_s256 === "string"
        ? await liveMission(tenant, agent, unverified.mission_s256)
        : undefined;
    if (!mission)
      throw new AAuthError(
        403,
        "access_denied",
        "an auth token is issued only within a mission",
      );
    if (!mission.resources.includes(resource))
      throw new AAuthError(
        403,
        "access_denied",
        "this mission does not cover that resource",
      );
    const rt = await discoverJwks({
      iss: resource,
      dwk: "aauth-resource.json",
      fetch: fetchLike,
    })
      .then((jwks) =>
        jwtVerify(resource_token, createLocalJWKSet(jwks), {
          typ: "aa-resource+jwt",
          issuer: resource,
          algorithms: ["Ed25519", "ES256"],
        }),
      )
      .then((r) => r.payload)
      .catch((err: Error) => {
        throw invalid(err.message);
      });
    if (rt.aud !== issuer || trim(String(rt.ps ?? "")) !== issuer)
      throw invalid("not for this Person Server");
    if (rt.agent_jkt !== agent.jkt)
      throw invalid("agent_jkt is not the signer");
    if (
      presented.jti !== rt.presented_jti ||
      presented.sub !== rt.sub ||
      presented.mission_s256 !== rt.mission_s256 ||
      presented.tenant !== rt.tenant ||
      presented.aud !== resource
    )
      throw invalid("does not match the presented token");
    return { tenant, rt, mission, resource };
  }

  /** The resource's one-line description of the request, from its R3 proposal; undefined if it has none. */
  async function proposalSummary(rt: JWTPayload): Promise<string | undefined> {
    if (typeof rt.r3_uri !== "string" || typeof rt.r3_s256 !== "string")
      return undefined;
    try {
      const { headers } = await signedFetch(rt.r3_uri, {
        method: "GET",
        signingKey: signer.privateJwk as JsonWebKey,
        signatureKey: {
          type: "jwks_uri",
          id: issuer,
          kid: signer.kid,
          dwk: DWK,
        },
        dryRun: true,
      });
      const response = await fetchLike(rt.r3_uri, { headers });
      const bytes = await response.text();
      if (!response.ok || !(await verifyR3Hash(bytes, rt.r3_s256)))
        return undefined;
      const summary = (JSON.parse(bytes) as { display?: { summary?: unknown } })
        .display?.summary;
      return typeof summary === "string" ? summary : undefined;
    } catch {
      return undefined;
    }
  }

  async function requestAuthToken(
    request: Request,
    path: string,
  ): Promise<Response> {
    const { agent, params } = await readSigned(request, path);
    const { tenant, rt, mission, resource } = await verifyResourceToken(
      agent,
      params,
    );
    const budget = (() => {
      try {
        return readBudget(rt.budget);
      } catch {
        throw new AAuthError(
          400,
          "invalid_resource_token",
          "budget is not a budget object",
        );
      }
    })();
    const grant: Record<string, unknown> = {
      aud: resource,
      sub: rt.sub,
      ...Object.fromEntries(
        (["scope", "r3_uri", "r3_s256"] as const)
          .filter((k) => k in rt)
          .map((k) => [k, rt[k]]),
      ),
      ...(budget ? { budget } : {}),
    };
    if (!budget) return Response.json(await authToken(agent, mission, grant));
    if (mission.budget && sameScale(mission.budget, budget)) {
      const spent = await store.spend(
        tenant,
        mission.s256,
        budget.amount,
        true,
        now(),
      );
      if (spent) return Response.json(await authToken(agent, spent, grant));
    }
    return ask(
      tenant,
      "auth_token",
      agent,
      mission.person,
      String(rt.scope ?? "a request"),
      {
        mission_s256: mission.s256,
        resource,
        budget,
        grant,
        summary: await proposalSummary(rt),
      },
    );
  }
  // #endregion

  return { requestAuthToken };
}
