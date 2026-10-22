/** Plumbing every AAuth server here shares: discovery, routing, signatures and errors. */
import {
  isInnerList,
  parseDictionary,
  type VerificationResult,
  verify,
} from "@hellocoop/httpsig";
import type { JWK } from "jose";

import { AAuthError, problem, Unauthorized } from "./errors.js";
import type { Signer } from "./signer.js";

/** The components the signature labelled `label` covers, as its `Signature-Input` lists them. */
function coveredComponents(headers: Headers, label: string): string[] {
  try {
    const member = parseDictionary(headers.get("signature-input") ?? "").get(
      label,
    );
    if (!member || !isInnerList(member)) return [];
    return member[0].map(([value]) => String(value));
  } catch {
    return [];
  }
}

/**
 * Verify a request's RFC 9421 signature as it was addressed: `authority` and
 * `path`, whatever routed it here. A body must be covered by `content-digest`
 * and `content-type`, as the profile requires of a request to a Person Server
 * or Access Server (#covered-components).
 */
export async function verifySignature(
  request: Request,
  body: string | undefined,
  authority: string,
  path: string,
): Promise<VerificationResult> {
  const signed = await verify(
    {
      method: request.method,
      authority,
      path,
      headers: request.headers,
      ...(body ? { body } : {}),
    },
    { requireContentDigest: true, supportedAlgorithms: ["Ed25519", "ES256"] },
  );
  if (!signed.verified)
    throw Unauthorized.signature(
      signed.signatureError?.error ?? "invalid_signature",
      signed.error ?? "signature does not verify",
    );
  if (body) {
    const covered = coveredComponents(request.headers, signed.label);
    if (
      !covered.includes("content-type") ||
      !covered.includes("content-digest")
    )
      throw Unauthorized.signature(
        "invalid_signature",
        "a body is signed with content-type and content-digest",
      );
  }
  return signed;
}

/** `/.well-known/{dwk}` and `/.well-known/jwks.json`; undefined for any other request. */
export function discovery(
  request: Request,
  pathname: string,
  dwk: string,
  metadata: () => Record<string, unknown>,
  jwks: { keys: JWK[] },
): Response | undefined {
  if (request.method !== "GET") return undefined;
  if (pathname === `/.well-known/${dwk}`) return Response.json(metadata());
  if (pathname === "/.well-known/jwks.json") return Response.json(jwks);
  return undefined;
}

/** The route a path names under `base`; undefined when it is not under it. */
export const beneath = (pathname: string, base: string) =>
  !base || pathname.startsWith(`${base}/`)
    ? pathname.slice(base.length)
    : undefined;

/** Answer `route`'s response, an AAuth error as its problem, nothing as a 404, and anything else as a 500. */
export async function answer(
  route: () => Promise<Response | undefined>,
): Promise<Response> {
  try {
    return (await route()) ?? problem(404, "not_found");
  } catch (err) {
    if (err instanceof AAuthError)
      return problem(err.status, err.error, err.message, err.headers);
    return problem(500, "server_error", (err as Error).message);
  }
}

/**
 * What every AAuth server here is: an issuer with a signing key, publishing
 * its metadata and keys under `/.well-known/`, and answering its routes with
 * AAuth errors as problem responses.
 */
export abstract class AAuthServer {
  protected constructor(
    readonly issuer: string,
    /** Where its routes live under the issuer, e.g. `/ps`; empty for the root. */
    protected readonly base: string,
    protected readonly signer: Signer,
    /** The well-known document its metadata is served as. */
    private readonly dwk: string,
    private readonly naming: { name?: string; description?: string },
  ) {}

  abstract metadata(): Record<string, unknown>;

  /** The request its route `path` (under its base) names; undefined for one it does not serve. */
  protected abstract serve(
    request: Request,
    path: string | undefined,
  ): Promise<Response | undefined>;

  jwks(): { keys: JWK[] } {
    return this.signer.jwks;
  }

  /**
   * Answer any request this server serves; undefined for one it does not.
   * `pathname` is the path the request addressed, when a framework rewrote `request.url`.
   */
  async route(
    request: Request,
    pathname = new URL(request.url).pathname,
  ): Promise<Response | undefined> {
    return (
      discovery(
        request,
        pathname,
        this.dwk,
        () => this.metadata(),
        this.signer.jwks,
      ) ?? this.serve(request, beneath(pathname, this.base))
    );
  }

  /** Like `route`, with AAuth errors answered as problem responses and anything else a 404. */
  handle(request: Request, pathname?: string): Promise<Response> {
    return answer(() => this.route(request, pathname));
  }

  /** What every server's metadata carries: its issuer, name, description and keys. */
  protected commonMetadata() {
    const { name, description } = this.naming;
    return {
      issuer: this.issuer,
      ...(name ? { name } : {}),
      ...(description ? { description } : {}),
      jwks_uri: `${this.issuer}/.well-known/jwks.json`,
    };
  }
}
