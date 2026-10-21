/**
 * An HTTP API as a native AAuth resource. Policy is not the resource's job: an
 * operation that needs a person's say asks for a person token from their Person
 * Server, then for an auth token for exactly this call, which the resource
 * describes in a per-call R3 proposal only that Person Server may read, with
 * its price as a budget any Person Server can weigh without reading R3.
 */
import {
  AAuthTokenError,
  MemoryR3Store,
  type R3Store,
  type TokenKind,
  type VerifiedToken,
  buildRequirementHeader,
  createResourceToken,
  publishProposal,
  serveR3Document,
  verifyProposalParameters,
  verifyToken,
} from "@aauth/resource";
import {
  generateAcceptSignatureSchemeHeader,
  generateSignatureErrorHeader,
  type SignatureErrorCode,
  verify,
} from "@hellocoop/httpsig";
import {
  type CryptoKey,
  type JWK,
  type JWTPayload,
  SignJWT,
  createLocalJWKSet,
  decodeJwt,
  exportJWK,
  generateKeyPair,
  importPKCS8,
  jwtVerify,
} from "jose";

import {
  AAuthError,
  type Budget,
  type FetchLike,
  httpsOnly,
  parseBudget,
  problem,
  sameScale,
} from "@introspection-sdk/aauth-protocol";

/** RFC 9864's fully-specified identifier; the polymorphic `EdDSA` is not used. */
const ALG = "Ed25519";

/** draft-hardt-aauth-budgets: an amount in a unit's smallest denomination. */
export type { Budget };

export interface AAuthResourceOptions {
  /** This resource's identifier: `https://host`, the origin agents call. */
  issuer: string;
  name: string;
  description?: string;
  /** Each scope this resource asks Person Servers to approve, described for people. */
  scopes: Record<string, string>;
  /** The R3 vocabulary its proposals are written in; `{issuer}/r3/vocabulary` by default. */
  vocabulary?: string;
  /** The budget units its resource tokens carry, advertised in its metadata. */
  budgetUnits?: { unit: string; decimals: number }[];
  /**
   * Person Servers whose people it serves. Verifying a token fetches its
   * issuer's keys, which is egress, so the list is closed.
   */
  personServers: readonly string[];
  /** Agent Providers whose agent tokens it accepts. */
  agentProviders: readonly string[];
  /**
   * This resource's own Access Server (draft -11 four-party), when it has one:
   * its resource tokens name it as `aud`, so the person's Person Server
   * redeems them there, and it accepts only the auth tokens that AS issues for
   * the people of `personServers`, never one a Person Server issued itself,
   * which would skip the AS's policy. Unset, each Person Server issues them.
   */
  accessServer?: string;
  /** A PKCS#8 PEM to keep the key across restarts; a fresh key otherwise. */
  /** For fetching the keys of the tokens it verifies; global fetch by default. Only `https`, never redirected. */
  fetch?: FetchLike;
  signingKey?: string;
  kid?: string;
  /** Where proposals live until their Person Server reads them; in memory by default. */
  r3Store?: R3Store;
  /** Called as each call is put to a Person Server, e.g. to log or narrate it. */
  onPropose?: (proposal: {
    ps: string;
    scope: string;
    parameters: Record<string, string>;
    mission_s256?: string;
  }) => void;
}

/** What one call asks the person's Person Server to approve. */
export interface AuthorizeRequest {
  scope: string;
  /** The operation, as the vocabulary names it, e.g. `{ action: "order" }`. */
  operation: Record<string, string>;
  /** Exactly the parameters an approval binds: a retry must present the same. */
  parameters: Record<string, string>;
  /** One line for whoever approves it. */
  summary: string;
  /** The call's price, so a Person Server can weigh it against a mission's budget. */
  budget?: Budget;
}

export type Authorization =
  | {
      ok: true;
      token: VerifiedToken;
      /** The person the call is for, as their Person Server names them. */
      sub: string;
      /** The Person Server that approved it. */
      ps: string;
      mission_s256?: string;
      /** The auth token's `jti`, to make a retried call idempotent. */
      jti: string;
    }
  | { ok: false; response: Response };

export type Identification =
  | {
      ok: true;
      token: VerifiedToken;
      /** The person the call is for, as their Person Server names them. */
      sub: string;
      /** The person's Person Server. */
      ps: string;
      mission_s256?: string;
    }
  | { ok: false; response: Response };

export interface AAuthResource {
  readonly issuer: string;
  /** `/.well-known/aauth-resource.json`. */
  metadata(): Record<string, unknown>;
  /** `/.well-known/jwks.json`. */
  jwks(): { keys: JWK[] };
  /** Sign facts this resource vouches for, such as a quote; `iss` is this resource. */
  sign(claims: Record<string, unknown>): Promise<string>;
  /** Verify a token this resource signed; a 400 problem otherwise. */
  verifySigned(token: string): Promise<JWTPayload>;
  /**
   * Admit a call on an auth token whose R3 proposal is exactly `ask`, or answer
   * with the challenge for what it lacks. `body` is the raw request body the
   * signature covers. `ask` may be a function, run once the presented token
   * verifies, so a resource challenges before it validates the call; an error
   * it throws propagates. `url` is the public URL the request was addressed to,
   * when the app serves it under another path; `{issuer}{path}` by default.
   */
  authorize(
    request: Request,
    body: string,
    ask:
      | AuthorizeRequest
      | ((
          token: VerifiedToken,
        ) => AuthorizeRequest | Promise<AuthorizeRequest>),
    options?: { url?: string },
  ): Promise<Authorization>;
  /**
   * Admit a call on a person token alone, for an operation that spends nothing
   * and needs no one's approval, such as undoing the person's own earlier call:
   * it says who the agent acts for and under which mission, and the resource
   * checks the call against that. Answers the person-token challenge otherwise.
   */
  authenticate(
    request: Request,
    body: string,
    options?: { url?: string },
  ): Promise<Identification>;
  /** An R3 proposal, to the Person Server it was published for and no one else. */
  serveProposal(request: Request, key: string): Promise<Response>;
  /** Serve this resource's discovery documents and R3 proposals; undefined for other paths. */
  handle(request: Request): Promise<Response | undefined>;
}

/** Run a handler, answering any AAuthError as a problem response. */
export async function respond(run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AAuthError)
      return problem(err.status, err.error, err.message, err.headers);
    throw err;
  }
}

function signatureError(code: SignatureErrorCode, detail: string): AAuthError {
  const headers: Record<string, string> = {
    "Signature-Error": generateSignatureErrorHeader({ error: code }),
  };
  if (code === "unsupported_scheme")
    headers["Accept-Signature-Scheme"] = generateAcceptSignatureSchemeHeader([
      "jwt",
    ]);
  return new AAuthError(401, code, detail, headers);
}

const challenge = (
  requirement: Parameters<typeof buildRequirementHeader>[0],
  detail: string,
) =>
  Response.json(
    { error: "unauthorized", detail },
    {
      status: 401,
      headers: {
        "AAuth-Requirement": buildRequirementHeader(requirement),
        "Content-Type": "application/problem+json",
      },
    },
  );

interface SignedRequest {
  keyType: "jwt" | "jwks_uri" | "hwk" | "jkt_jwt";
  thumbprint: string;
  jwt?: string;
  server?: string;
}

// #region verify-signature
/** Verify the RFC 9421 signature on a request as addressed to `url`; a body must be covered by `content-digest`. */
async function verifySignature(
  request: Request,
  body: string | undefined,
  url: string,
): Promise<SignedRequest> {
  const { host, pathname } = new URL(url);
  const result = await verify(
    {
      method: request.method,
      authority: host,
      path: pathname,
      headers: request.headers,
      ...(body ? { body } : {}),
    },
    { requireContentDigest: true, supportedAlgorithms: ["Ed25519", "ES256"] },
  );
  if (!result.verified) {
    const code = result.signatureError?.error ?? "invalid_signature";
    throw signatureError(code, result.error ?? "signature does not verify");
  }
  return {
    keyType: result.keyType,
    thumbprint: result.thumbprint,
    ...(result.jwt ? { jwt: result.jwt.raw } : {}),
    ...(result.jwks_uri ? { server: result.jwks_uri.id } : {}),
  };
}
// #endregion

export async function createAAuthResource(
  options: AAuthResourceOptions,
): Promise<AAuthResource> {
  const issuer = options.issuer.replace(/\/+$/, "");
  if (!issuer.startsWith("https://"))
    throw new Error("issuer must be an https origin");
  const vocabulary = options.vocabulary ?? `${issuer}/r3/vocabulary`;
  const r3 = options.r3Store ?? new MemoryR3Store();
  const kid = options.kid ?? `${new URL(issuer).hostname}-1`;
  const privateKey: CryptoKey = options.signingKey
    ? await importPKCS8(options.signingKey, ALG, { extractable: true })
    : (await generateKeyPair(ALG, { extractable: true })).privateKey;
  const publicJwk: JWK = { ...(await exportJWK(privateKey)), kid, alg: ALG };
  delete publicJwk.d;
  const keys = { keys: [{ ...publicJwk, use: "sig" }] };
  const signWithHeader = (
    claims: Record<string, unknown>,
    header: Record<string, unknown>,
  ) =>
    new SignJWT(claims)
      .setProtectedHeader({ ...header, alg: ALG, kid } as { alg: string })
      .sign(privateKey);
  const accessServer = options.accessServer?.replace(/\/+$/, "");
  const keysFetch = httpsOnly(
    options.fetch ?? ((input, init) => fetch(input, init)),
  );
  if (accessServer !== undefined && !accessServer.startsWith("https://"))
    throw new Error("accessServer must be an https origin");
  const issuers: Record<TokenKind, readonly string[]> = {
    agent: options.agentProviders,
    person: options.personServers,
    auth: accessServer ? [accessServer] : options.personServers,
  };

  /** The token a signed request presented: a kind it accepts, from an issuer it trusts, binding the signing key. */
  async function verifyPresented(
    signed: SignedRequest,
    accept: TokenKind[],
  ): Promise<VerifiedToken> {
    if (signed.keyType !== "jwt" || !signed.jwt)
      throw signatureError("unsupported_scheme", "sign with sig=jwt");
    let claims: JWTPayload;
    try {
      claims = decodeJwt(signed.jwt);
    } catch {
      throw signatureError("invalid_jwt", "not a JWT");
    }
    // Checked before verifying, since verifying fetches the issuer's keys.
    if (!accept.some((kind) => issuers[kind]?.includes(String(claims.iss))))
      throw signatureError(
        "invalid_jwt",
        `${String(claims.iss)} is not trusted here`,
      );
    const token = await verifyToken({
      jwt: signed.jwt,
      httpSignatureThumbprint: signed.thumbprint,
      resource: issuer,
      accept,
      fetch: keysFetch,
    }).catch((err: Error) => {
      const code = err instanceof AAuthTokenError ? err.code : "invalid_jwt";
      throw signatureError(
        code === "token_expired" ? "expired_jwt" : "invalid_jwt",
        err.message,
      );
    });
    if (!issuers[token.type].includes(token.iss))
      throw signatureError("invalid_jwt", `${token.iss} does not issue those`);
    // An auth token is the Access Server's, for one of its Person Servers' people, or else that Person Server's own.
    if (
      token.type === "auth" &&
      (token.iss === accessServer
        ? token.dwk !== "aauth-access.json" ||
          !options.personServers.includes(token.ps)
        : token.dwk !== "aauth-person.json" || token.ps !== token.iss)
    )
      throw signatureError("invalid_jwt", "not an auth token issued here");
    return token;
  }

  // #region propose
  /** `401 requirement=auth-token`: a resource token for this one call, its proposal readable by the person's Person Server alone. */
  async function propose(
    token: VerifiedToken,
    agentJkt: string,
    ask: AuthorizeRequest,
  ): Promise<Response> {
    const ps = token.type === "auth" ? token.ps : token.iss;
    const proposal = await publishProposal({
      vocabulary,
      operation: ask.operation,
      parameters: ask.parameters,
      display: { summary: ask.summary },
      store: r3,
      baseUri: `${issuer}/r3`,
      // The Access Server reads it too, to weigh the call.
      authorized: accessServer ? [ps, accessServer] : [ps],
    });
    const resourceToken = await createResourceToken(
      {
        resource: issuer,
        audience: accessServer ?? ps,
        presentedToken: token as Parameters<
          typeof createResourceToken
        >[0]["presentedToken"],
        agentJkt,
        scope: ask.scope,
        kid,
        r3: { uri: proposal.r3_uri, s256: proposal.r3_s256 },
      },
      (claims, header) =>
        signWithHeader(
          { ...claims, ...(ask.budget ? { budget: ask.budget } : {}) },
          header,
        ),
    );
    options.onPropose?.({
      ps,
      scope: ask.scope,
      parameters: ask.parameters,
      ...("mission_s256" in token && token.mission_s256
        ? { mission_s256: token.mission_s256 }
        : {}),
    });
    return challenge(
      { requirement: "auth-token", resourceToken },
      `take the resource token to ${ps}`,
    );
  }
  // #endregion

  /**
   * The person or auth token a signed call presents, with the signed request,
   * or the challenge for a person token when it presents none.
   */
  async function presented(
    request: Request,
    body: string,
    url: string | undefined,
  ): Promise<
    { signed: SignedRequest; token: VerifiedToken } | { challenge: Response }
  > {
    if (!request.headers.get("signature-key"))
      return {
        challenge: challenge(
          { requirement: "person-token" },
          "sign the request",
        ),
      };
    const signed = await verifySignature(
      request,
      body,
      url ?? `${issuer}${new URL(request.url).pathname}`,
    );
    const token = await verifyPresented(signed, ["agent", "person", "auth"]);
    if (token.type === "agent")
      return {
        challenge: challenge(
          { requirement: "person-token" },
          "present a person token from the person's Person Server",
        ),
      };
    return { signed, token };
  }

  /** Who a verified token is for, and under which mission. */
  const caller = (token: VerifiedToken) => ({
    token,
    sub: token.sub,
    ps: token.type === "auth" ? token.ps : token.iss,
    ...("mission_s256" in token && token.mission_s256
      ? { mission_s256: token.mission_s256 }
      : {}),
  });

  /** Run `admit`, answering an AAuthError as its problem response. */
  async function admitting<T extends { ok: boolean }>(
    admit: () => Promise<T>,
  ): Promise<T | { ok: false; response: Response }> {
    try {
      return await admit();
    } catch (err) {
      if (err instanceof AAuthError)
        return {
          ok: false,
          response: problem(err.status, err.error, err.message, err.headers),
        };
      throw err;
    }
  }

  async function authorize(
    request: Request,
    body: string,
    asked:
      | AuthorizeRequest
      | ((
          token: VerifiedToken,
        ) => AuthorizeRequest | Promise<AuthorizeRequest>),
    { url }: { url?: string } = {},
  ): Promise<Authorization> {
    return admitting(async (): Promise<Authorization> => {
      const call = await presented(request, body, url);
      if ("challenge" in call) return { ok: false, response: call.challenge };
      const { signed, token } = call;
      const ask = typeof asked === "function" ? await asked(token) : asked;
      if (token.type === "auth" && token.r3_s256 && grants(token, ask)) {
        const approved = await verifyProposalParameters({
          store: r3,
          r3_s256: token.r3_s256,
          presented: ask.parameters,
          operation: ask.operation,
        }).then(
          () => true,
          () => false,
        );
        if (approved)
          return {
            ok: true,
            ...caller(token),
            jti: String(token.claims.jti),
          };
      }
      return {
        ok: false,
        response: await propose(token, signed.thumbprint, ask),
      };
    });
  }

  /**
   * Whether an auth token grants this call, whoever issued it: its `scope`
   * covers the call's, and its `budget`, in the call's unit and scale, covers
   * the call's price (draft-hardt-aauth-budgets #resource-enforces). An Access
   * Server may grant less than was asked; a token that does not cover the call
   * is answered with a fresh challenge, as for no token at all.
   */
  function grants(token: VerifiedToken, ask: AuthorizeRequest): boolean {
    const granted = new Set(
      String(token.claims.scope ?? "")
        .split(" ")
        .filter(Boolean),
    );
    if (
      !ask.scope
        .split(" ")
        .filter(Boolean)
        .every((s) => granted.has(s))
    )
      return false;
    if (!ask.budget) return true;
    let budget: Budget | undefined;
    try {
      budget = parseBudget(token.claims.budget);
    } catch {
      return false;
    }
    return (
      !!budget &&
      sameScale(budget, ask.budget) &&
      budget.amount >= ask.budget.amount
    );
  }

  async function authenticate(
    request: Request,
    body: string,
    { url }: { url?: string } = {},
  ): Promise<Identification> {
    return admitting(async (): Promise<Identification> => {
      const call = await presented(request, body, url);
      if ("challenge" in call) return { ok: false, response: call.challenge };
      return { ok: true, ...caller(call.token) };
    });
  }

  // #region serve-r3
  /** An R3 proposal, to the Person Server it was published for and no one else. */
  async function serveProposal(
    request: Request,
    key: string,
  ): Promise<Response> {
    const id = /jwks_uri;(?:[^,]*;)?id="([^"]+)"/.exec(
      request.headers.get("signature-key") ?? "",
    )?.[1];
    if (!id || !(options.personServers.includes(id) || id === accessServer))
      throw signatureError(
        "invalid_signature",
        "only the person's Person Server, or this resource's Access Server, reads a proposal",
      );
    const signed = await verifySignature(
      request,
      undefined,
      `${issuer}/r3/${key}`,
    );
    const served = await serveR3Document({
      store: r3,
      key,
      signer: signed.server,
    });
    return new Response(served.body, {
      status: served.status,
      headers: served.headers,
    });
  }
  // #endregion

  const metadata = () => ({
    issuer,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    access_mode: "auth-token",
    name: options.name,
    ...(options.description ? { description: options.description } : {}),
    scope_descriptions: options.scopes,
    r3_vocabularies: [vocabulary],
    ...(options.budgetUnits ? { budget_units: options.budgetUnits } : {}),
    additional_signature_components: ["content-type", "content-digest"],
  });

  return {
    issuer,
    metadata,
    jwks: () => keys,
    sign: (claims) =>
      signWithHeader({ ...claims, iss: issuer }, { typ: "JWT" }),
    async verifySigned(token) {
      try {
        return (
          await jwtVerify(token, createLocalJWKSet(keys), {
            issuer,
            algorithms: [ALG],
          })
        ).payload;
      } catch {
        throw new AAuthError(
          400,
          "invalid_request",
          "not signed by this resource",
        );
      }
    },
    authorize,
    authenticate,
    serveProposal,
    async handle(request) {
      const { pathname } = new URL(request.url);
      if (request.method !== "GET") return undefined;
      if (pathname === "/.well-known/aauth-resource.json")
        return Response.json(metadata());
      if (pathname === "/.well-known/jwks.json") return Response.json(keys);
      const key = /^\/r3\/([^/]+)$/.exec(pathname)?.[1];
      if (key && key !== "vocabulary")
        return respond(() => serveProposal(request, key));
      return undefined;
    },
  };
}
