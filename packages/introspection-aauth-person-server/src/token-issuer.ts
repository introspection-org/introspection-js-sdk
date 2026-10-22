/** The person tokens and auth tokens a Person Server issues (#person-token, #auth-token). */
import { createHmac, randomUUID } from "node:crypto";

import type { AuthGrant, Signer } from "@introspection-sdk/aauth-protocol";
import type { JWTPayload } from "jose";

import type { Issued } from "./options.js";
import type { Agent, Mission, Person } from "./types.js";

const DWK = "aauth-person.json";

export class TokenIssuer {
  constructor(
    private readonly issuer: string,
    private readonly signer: Signer,
    /** Keys each person's directed `sub`, apart from the signing key. */
    private readonly subjectSecret: string,
    private readonly tokenTtl: number,
    private readonly now: () => number,
    private readonly onIssued?: (issued: Issued) => void | Promise<void>,
  ) {}

  /** A person token for `resource`, within `mission` when given. */
  async personToken(
    agent: Agent,
    person: Person,
    resource: string,
    mission?: Mission,
  ) {
    const { token, expires_in } = await this.issue(
      "aa-person+jwt",
      {
        aud: resource,
        sub: this.directed(person, resource),
        cnf: { jwk: agent.jwk },
        ...(mission ? { mission_s256: mission.s256 } : {}),
      },
      Math.min(agent.exp, mission?.expires_at ?? Infinity),
      person,
    );
    await this.onIssued?.({
      type: "person_token",
      agent,
      person,
      resource,
      ...(mission ? { mission } : {}),
    });
    return { person_token: token, expires_in };
  }

  /** An auth token for `grant`, within `mission`. */
  async authToken(agent: Agent, mission: Mission, grant: AuthGrant) {
    const { token, expires_in } = await this.issue(
      "aa-auth+jwt",
      {
        ps: this.issuer,
        cnf: { jwk: agent.jwk },
        mission_s256: mission.s256,
        ...grant,
      },
      Math.min(agent.exp, mission.expires_at),
      mission.person,
    );
    await this.onIssued?.({
      type: "auth_token",
      agent,
      person: mission.person,
      resource: grant.aud,
      mission,
      ...(grant.budget ? { budget: grant.budget } : {}),
    });
    return { auth_token: token, expires_in };
  }

  /** The person's identifier at one audience: no two audiences can correlate it. */
  private directed(person: Person, audience: string) {
    return createHmac("sha256", this.subjectSecret)
      .update(`${person.id}\n${audience}`)
      .digest("base64url");
  }

  private async issue(
    typ: string,
    claims: JWTPayload,
    notAfter: number,
    person: Person,
  ) {
    const iat = this.now();
    const exp = Math.min(iat + this.tokenTtl, notAfter);
    const token = await this.signer.sign(
      {
        ...(person.tenant ? { tenant: person.tenant } : {}),
        iss: this.issuer,
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
}
