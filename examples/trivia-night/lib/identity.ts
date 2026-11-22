/**
 * Who is asking. The bank keys everything on the end user the platform names
 * in each call's `Authorization: Bearer` token, an ES256 JWT issued for the
 * application the MCP server is linked to. Nothing in a tool's arguments can
 * name an owner.
 */
import { createRemoteJWKSet, jwtVerify } from "jose";

const ISSUER = process.env.TRIVIA_ISSUER;
const AUDIENCE = process.env.TRIVIA_AUDIENCE;
/** A backend naming a user is weaker than the platform verifying one. */
const ACCEPT_ATTRIBUTION = process.env.TRIVIA_ACCEPT_ATTRIBUTION === "1";
/** For local runs with no platform: trust an `x-trivia-owner` header. */
const DEV_OWNER_HEADER = process.env.TRIVIA_DEV_OWNER_HEADER === "1";

const keys = ISSUER
  ? createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`))
  : undefined;

export class Unidentified extends Error {}

export async function ownerOf(request: Request): Promise<string> {
  const bearer = /^Bearer\s+(.+)$/i.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  if (keys && bearer) {
    const { payload } = await jwtVerify(bearer, keys, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["ES256"],
    }).catch(() => {
      throw new Unidentified("the end-user token did not verify");
    });
    const accepted =
      payload.type === "identity_assertion" ||
      (ACCEPT_ATTRIBUTION && payload.type === "identity_attribution");
    if (!accepted || !payload.sub)
      throw new Unidentified(`a ${String(payload.type)} token is not accepted`);
    return payload.sub;
  }
  const header = request.headers.get("x-trivia-owner");
  if (DEV_OWNER_HEADER && header) return header;
  throw new Unidentified("no end user: the call carried no accepted token");
}
