import { verifyR3Hash } from "@aauth/resource";
import { fetch as signedFetch } from "@hellocoop/httpsig";
import type { JWTPayload } from "jose";

import type { Signer } from "./signer.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Who reads an R3 proposal: a server signing with `sig=jwks_uri` under its metadata document `dwk`. */
export interface ProposalReader {
  issuer: string;
  dwk: string;
  signer: Signer;
  fetch: FetchLike;
}

/**
 * The resource's one-line description of a request, from the R3 proposal a
 * resource token names; undefined if it names none, or the proposal cannot be
 * read or does not match its hash.
 */
/** Whether `url` is on the https origin of `issuer`, and carries no credentials. */
function onOrigin(url: string, issuer: unknown): boolean {
  try {
    const at = new URL(url);
    return (
      typeof issuer === "string" &&
      at.protocol === "https:" &&
      !at.username &&
      !at.password &&
      at.origin === new URL(issuer).origin
    );
  } catch {
    return false;
  }
}

export async function readProposalSummary(
  rt: JWTPayload,
  reader: ProposalReader,
): Promise<string | undefined> {
  if (typeof rt.r3_uri !== "string" || typeof rt.r3_s256 !== "string")
    return undefined;
  // Read only from the resource that signed the token, so a resource token cannot send this server elsewhere.
  if (!onOrigin(rt.r3_uri, rt.iss)) return undefined;
  try {
    const { headers } = await signedFetch(rt.r3_uri, {
      method: "GET",
      signingKey: reader.signer.privateJwk as JsonWebKey,
      signatureKey: {
        type: "jwks_uri",
        id: reader.issuer,
        kid: reader.signer.kid,
        dwk: reader.dwk,
      },
      dryRun: true,
    });
    const response = await reader.fetch(rt.r3_uri, { headers });
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
