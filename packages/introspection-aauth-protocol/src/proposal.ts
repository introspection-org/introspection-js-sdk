import { verifyR3Hash } from "@aauth/resource";
import { fetch as signedFetch } from "@hellocoop/httpsig";
import { trace } from "@opentelemetry/api";
import type { JWTPayload } from "jose";

import type { FetchLike } from "./fetch.js";
import type { Signer } from "./signer.js";
import { onOrigin } from "./urls.js";

const tracer = trace.getTracer("@introspection-sdk/aauth-protocol");

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
export async function readProposalSummary(
  rt: JWTPayload,
  reader: ProposalReader,
): Promise<string | undefined> {
  if (typeof rt.r3_uri !== "string" || typeof rt.r3_s256 !== "string")
    return undefined;
  // Read only from the resource that signed the token, so a resource token cannot send this server elsewhere.
  if (!onOrigin(rt.r3_uri, rt.iss)) return undefined;
  const { r3_uri, r3_s256 } = rt;
  return tracer.startActiveSpan(
    "aauth.r3.read",
    { attributes: { "aauth.resource": String(rt.iss) } },
    async (span) => {
      try {
        const { headers } = await signedFetch(r3_uri, {
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
        const response = await reader.fetch(r3_uri, { headers });
        const bytes = await response.text();
        if (!response.ok || !(await verifyR3Hash(bytes, r3_s256)))
          return undefined;
        const summary = (
          JSON.parse(bytes) as { display?: { summary?: unknown } }
        ).display?.summary;
        return typeof summary === "string" ? summary : undefined;
      } catch {
        return undefined;
      } finally {
        span.end();
      }
    },
  );
}
