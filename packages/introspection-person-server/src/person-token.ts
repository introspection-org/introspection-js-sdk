/** Minting person tokens and auth tokens, and the person token endpoint. */
import { createHmac, randomUUID } from "node:crypto";

import type { JWTPayload } from "jose";

import { type Context, DWK, trim } from "./context.js";
import { AAuthError } from "./errors.js";
import type { Missions } from "./missions.js";
import type { Agent, Budget, Mission, Person } from "./types.js";
import type { AgentVerifier } from "./verify-agent.js";

export type Tokens = ReturnType<typeof createTokens>;

export function createTokens(
  { options, issuer, signer, secret, now, tokenTtl }: Context,
  {
    readSigned,
    requester,
    liveMission,
  }: Pick<AgentVerifier, "readSigned" | "requester"> &
    Pick<Missions, "liveMission">,
) {
  // #region person-token
  /** The person's identifier at one audience: no two audiences can correlate it. */
  const directed = (person: Person, audience: string) =>
    createHmac("sha256", secret)
      .update(`${person.id}\n${audience}`)
      .digest("base64url");

  async function issue(
    typ: string,
    claims: JWTPayload,
    notAfter: number,
    person: Person,
  ) {
    const iat = now();
    const exp = Math.min(iat + tokenTtl, notAfter);
    const token = await signer.sign(
      {
        ...(person.tenant ? { tenant: person.tenant } : {}),
        iss: issuer,
        dwk: DWK,
        jti: randomUUID(),
        iat,
        exp,
        ...claims,
      },
      typ,
    );
    return { token, expires_in: exp - iat };
  }

  async function personToken(
    agent: Agent,
    person: Person,
    resource: string,
    mission?: Mission,
  ) {
    const { token, expires_in } = await issue(
      "aa-person+jwt",
      {
        aud: resource,
        sub: directed(person, resource),
        cnf: { jwk: agent.jwk },
        ...(mission ? { mission_s256: mission.s256 } : {}),
      },
      Math.min(agent.exp, mission?.expires_at ?? Infinity),
      person,
    );
    await options.onIssued?.({
      type: "person_token",
      agent,
      person,
      resource,
      ...(mission ? { mission } : {}),
    });
    return { person_token: token, expires_in };
  }

  async function authToken(
    agent: Agent,
    mission: Mission,
    grant: Record<string, unknown>,
  ) {
    const { token, expires_in } = await issue(
      "aa-auth+jwt",
      {
        ps: issuer,
        cnf: { jwk: agent.jwk },
        mission_s256: mission.s256,
        ...grant,
      },
      Math.min(agent.exp, mission.expires_at),
      mission.person,
    );
    await options.onIssued?.({
      type: "auth_token",
      agent,
      person: mission.person,
      resource: String(grant.aud),
      mission,
      ...(grant.budget ? { budget: grant.budget as Budget } : {}),
    });
    return { auth_token: token, expires_in };
  }

  async function requestPersonToken(
    request: Request,
    path: string,
  ): Promise<Response> {
    const { agent, params } = await readSigned(request, path);
    const resource = trim(String(params.resource ?? ""));
    if (!resource.startsWith("https://"))
      throw new AAuthError(
        400,
        "invalid_request",
        "resource is an https origin",
      );
    const { tenant, person } = await requester(agent, params);
    const mission =
      params.mission_s256 === undefined
        ? undefined
        : await liveMission(tenant, agent, params.mission_s256);
    if (mission && mission.person.id !== person.id)
      throw new AAuthError(404, "mission_not_found", "no such mission");
    return Response.json(await personToken(agent, person, resource, mission));
  }

  // #endregion

  return { personToken, authToken, requestPersonToken };
}
