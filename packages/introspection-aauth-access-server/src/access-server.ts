/**
 * An AAuth Access Server (draft-hardt-oauth-aauth-protocol -11, four-party).
 *
 * A resource that keeps its own policy names this server as the `aud` of its
 * resource tokens. The person's Person Server redeems them here: it signs the
 * request with its own key and sends the resource token, the agent's token and
 * the token the resource saw. This server verifies all of it, asks the
 * resource's policy, and issues an auth token for the resource, or makes the
 * Person Server wait while someone decides.
 */
import { randomUUID } from "node:crypto";

import { buildRequirementHeader } from "@aauth/resource";
import {
  AAuthError,
  answer,
  authGrant,
  beneath,
  discovery,
  httpsOnly,
  loadSigner,
  parseBudget,
  problem,
  readJsonObject,
  readProposalSummary,
  sameScale,
  signatureError,
  tokenLifetime,
  trimIdentifier,
  verifySignature,
} from "@introspection-sdk/aauth-protocol";
import type { JWK, JWTPayload } from "jose";

import type {
  AccessDecision,
  AccessGrant,
  AccessRequest,
  Budget,
  IssuedAccess,
  PendingAccess,
  Policy,
} from "./types.js";
import {
  type Verifier,
  verifyAgentToken,
  verifyPresentedToken,
  verifyResourceToken,
} from "./verify.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const DWK = "aauth-access.json";

export interface AccessServerOptions {
  /** This Access Server's identifier: `https://host`, no port or path. */
  issuer: string;
  /** The resources it decides for (their `iss`). Verifying a resource token fetches its keys, so the list is closed. */
  resources: readonly string[];
  /** The Person Servers it takes token requests from. */
  personServers: readonly string[];
  /** The agent providers whose agents it serves. */
  agentProviders: readonly string[];
  /** The resource's policy. */
  policy: Policy;
  /** PKCS#8 Ed25519 PEM. Unset, a fresh key per process. */
  signingKey?: string;
  kid?: string;
  name?: string;
  description?: string;
  /** Where the routes live under the issuer, e.g. `/as`. Default: the root. */
  basePath?: string;
  /** At most an hour. */
  tokenTtlSeconds?: number;
  /** How long a request may wait on a decision. */
  pendingTtlSeconds?: number;
  retryAfterSeconds?: number;
  /** Called with each request the policy waits on, to reach whoever decides. */
  onPending?: (pending: PendingAccess) => void | Promise<void>;
  /** Called with each auth token issued. */
  onIssued?: (issued: IssuedAccess) => void | Promise<void>;
  /** For discovery and R3 reads; global fetch by default. */
  fetch?: FetchLike;
  /** Seconds since the epoch; for tests. */
  now?: () => number;
}

const words = (value: unknown) =>
  typeof value === "string" ? value.split(" ").filter(Boolean) : [];

/** `scope`, unless it is broader than `asked`. */
function narrowed(asked: unknown, scope: string | undefined) {
  if (scope === undefined) return typeof asked === "string" ? asked : undefined;
  const allowed = new Set(words(asked));
  if (words(scope).some((s) => !allowed.has(s)))
    throw new AAuthError(
      500,
      "server_error",
      "the policy granted a scope that was not asked for",
    );
  return scope;
}

function readTokens(body: string) {
  const { resource_token, agent_token, presented_token, budget } =
    readJsonObject(body);
  if (
    typeof resource_token !== "string" ||
    typeof agent_token !== "string" ||
    typeof presented_token !== "string"
  )
    throw new AAuthError(
      400,
      "invalid_request",
      "resource_token, agent_token and presented_token are required",
    );
  return {
    resource_token,
    agent_token,
    presented_token,
    budget: parseBudget(budget),
  };
}

/**
 * What this request may spend (draft-hardt-aauth-budgets #as-token-endpoint):
 * the budget the Person Server sent, which may not exceed the resource token's.
 */
function bounded(sent: Budget | undefined, asked: Budget | undefined) {
  if (!sent || !asked) return sent;
  if (!sameScale(sent, asked))
    throw new AAuthError(
      400,
      "invalid_request",
      "the budget is not in the resource token's unit",
    );
  return sent.amount <= asked.amount ? sent : asked;
}

/** The grant with the policy's lower budget, which may not exceed what may be spent. */
function lowered(
  grant: AccessGrant,
  bound: Budget | undefined,
  lower: Budget | undefined,
): AccessGrant {
  if (!lower) return grant;
  let checked: Budget | undefined;
  try {
    checked = parseBudget(lower);
  } catch {
    checked = undefined;
  }
  if (
    !checked ||
    !bound ||
    !sameScale(checked, bound) ||
    checked.amount > bound.amount
  )
    throw new AAuthError(
      500,
      "server_error",
      "the policy granted a budget above what was asked",
    );
  return { ...grant, budget: checked };
}

/** The claims an auth token for `rt` carries besides its own, copied from the resource token; its scope is the policy's. */
function grantFor(rt: JWTPayload, budget: Budget | undefined): AccessGrant {
  const copied = authGrant(rt, String(rt.iss), budget);
  delete copied.scope;
  return {
    ...copied,
    ps: String(rt.ps),
    ...(typeof rt.mission_s256 === "string"
      ? { mission_s256: rt.mission_s256 }
      : {}),
    ...(typeof rt.tenant === "string" ? { tenant: rt.tenant } : {}),
  };
}

/** The `AAuth-Requirement` a pending request is answered with; a policy's bad interaction is a 500. */
function requirementHeader(interaction: PendingAccess["interaction"]): string {
  if (!interaction) return buildRequirementHeader({ requirement: "approval" });
  let https = false;
  try {
    https = new URL(interaction.url).protocol === "https:";
  } catch {
    // answered below
  }
  try {
    if (https)
      return buildRequirementHeader({
        requirement: "interaction",
        ...interaction,
      });
  } catch {
    // answered below
  }
  throw new AAuthError(
    500,
    "server_error",
    "the policy's interaction needs an https url and a code of printable ASCII",
  );
}

export type AccessServer = Awaited<ReturnType<typeof createAccessServer>>;

export async function createAccessServer(options: AccessServerOptions) {
  const issuer = trimIdentifier(options.issuer);
  if (!issuer.startsWith("https://"))
    throw new Error("issuer must be an https origin");
  const base = trimIdentifier(options.basePath ?? "");
  const signer = await loadSigner(options.signingKey, options.kid);
  const fetchLike: FetchLike = httpsOnly(
    options.fetch ?? ((input, init) => fetch(input, init)),
  );
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const tokenTtl = tokenLifetime(options.tokenTtlSeconds);
  const pendingTtl = options.pendingTtlSeconds ?? 24 * 60 * 60;
  const retryAfter = options.retryAfterSeconds ?? 5;
  const personServers = options.personServers.map(trimIdentifier);
  const verifier: Verifier = {
    issuer,
    resources: options.resources.map(trimIdentifier),
    agentProviders: options.agentProviders.map(trimIdentifier),
    fetch: fetchLike,
    now,
  };
  const pending = new Map<string, PendingAccess>();

  const url = (path: string) => `${issuer}${base}${path}`;
  const endpoints = {
    token: url("/token"),
    pending: (id: string) => url(`/pending/${id}`),
  };

  /** The Person Server that signed a request, by `sig=jwks_uri` under its `aauth-person.json`. */
  async function personServer(
    request: Request,
    body: string | undefined,
    path: string,
  ): Promise<string> {
    const named = /jwks_uri;(?:[^,]*;)?id="([^"]+)"/.exec(
      request.headers.get("signature-key") ?? "",
    )?.[1];
    // Checked before verifying, since verifying fetches its keys.
    if (!named || !personServers.includes(named))
      throw signatureError(
        "invalid_signature",
        "sign as a Person Server this Access Server takes requests from",
      );
    const signed = await verifySignature(
      request,
      body,
      new URL(issuer).host,
      `${base}${path}`,
    );
    if (
      signed.keyType !== "jwks_uri" ||
      signed.jwks_uri?.dwk !== "aauth-person.json"
    )
      throw signatureError(
        "unsupported_scheme",
        "a Person Server signs with sig=jwks_uri and its aauth-person.json",
      );
    return signed.jwks_uri.id;
  }

  /** The request, verified, as the policy sees it. */
  async function readRequest(ps: string, body: string) {
    const tokens = readTokens(body);
    const rt = await verifyResourceToken(verifier, tokens.resource_token, ps);
    const agent = await verifyAgentToken(verifier, tokens.agent_token, rt, ps);
    const presented = await verifyPresentedToken(
      verifier,
      tokens.presented_token,
      rt,
      ps,
    );
    const summary = await readProposalSummary(rt, {
      issuer,
      dwk: DWK,
      signer,
      fetch: fetchLike,
    });
    let asked: Budget | undefined;
    try {
      asked = parseBudget(rt.budget);
    } catch {
      throw new AAuthError(
        400,
        "invalid_resource_token",
        "its budget is not a budget",
      );
    }
    const budget = bounded(tokens.budget, asked);
    const request: AccessRequest = {
      resource: String(rt.iss),
      ps,
      sub: String(rt.sub),
      ...(typeof rt.tenant === "string" ? { tenant: rt.tenant } : {}),
      ...(typeof rt.scope === "string" ? { scope: rt.scope } : {}),
      ...(typeof rt.mission_s256 === "string"
        ? { mission_s256: rt.mission_s256 }
        : {}),
      ...(budget ? { budget } : {}),
      ...(summary ? { summary } : {}),
      agent: { id: agent.sub, provider: agent.iss, jkt: String(rt.agent_jkt) },
      claims: {
        resource_token: rt,
        agent_token: agent.claims,
        presented_token: presented.claims,
      },
    };
    return {
      request,
      grant: grantFor(rt, budget),
      jwk: agent.cnf.jwk as JWK,
      not_after: Math.min(agent.exp, presented.exp),
    };
  }

  /** An auth token, `iss` this server, for no longer than an hour or the tokens it was asked with. */
  async function issue(
    issuing: Pick<PendingAccess, "request" | "grant" | "jwk" | "not_after">,
    scope: string | undefined,
  ): Promise<Response> {
    const iat = now();
    const exp = Math.min(iat + tokenTtl, issuing.not_after);
    const jti = randomUUID();
    const auth_token = await signer.sign(
      {
        iss: issuer,
        dwk: DWK,
        jti,
        iat,
        exp,
        ...issuing.grant,
        ...(scope ? { scope } : {}),
        cnf: { jwk: issuing.jwk },
      },
      "aa-auth+jwt",
    );
    await options.onIssued?.({
      request: issuing.request,
      jti,
      exp,
      ...(scope ? { scope } : {}),
    });
    return Response.json({ auth_token, expires_in: exp - iat });
  }

  const waiting = (record: PendingAccess) =>
    Response.json(
      { status: "pending" },
      {
        status: 202,
        headers: {
          Location: endpoints.pending(record.id),
          "Retry-After": String(retryAfter),
          "Cache-Control": "no-store",
          "AAuth-Requirement": requirementHeader(record.interaction),
        },
      },
    );

  /** #as-token-endpoint: a Person Server's signed request for an auth token. */
  async function requestToken(request: Request, path: string) {
    const body = await request.text();
    const ps = await personServer(request, body, path);
    const asked = await readRequest(ps, body);
    const verdict = await options.policy(asked.request);
    if (verdict.decision === "allow")
      return issue(
        {
          ...asked,
          grant: lowered(asked.grant, asked.request.budget, verdict.budget),
        },
        narrowed(asked.request.scope, verdict.scope),
      );
    if (verdict.decision === "deny")
      return problem(
        403,
        "denied",
        verdict.detail ?? "this resource's policy refuses it",
      );
    const interaction =
      verdict.decision === "interaction"
        ? { url: verdict.url, code: verdict.code }
        : undefined;
    requirementHeader(interaction);
    const created = now();
    const record: PendingAccess = {
      id: randomUUID(),
      status: "pending",
      requirement: verdict.decision,
      ...(interaction ? { interaction } : {}),
      ...asked,
      created_at: created,
      expires_at: Math.min(created + pendingTtl, asked.not_after),
    };
    pending.set(record.id, record);
    await options.onPending?.(record);
    return waiting(record);
  }

  /**
   * The Person Server polls a pending request with a signed GET; only the one
   * that asked may. A decision is answered once; the URL is `410` after
   * (#pending-url-security).
   */
  async function poll(request: Request, path: string, id: string) {
    const ps = await personServer(request, undefined, path);
    const record = pending.get(id);
    if (!record || record.request.ps !== ps)
      return problem(404, "not_found", "no such pending request");
    if (record.answered_at !== undefined)
      return problem(410, "invalid_code", "this request was answered already");
    if (record.status === "denied") {
      record.answered_at = now();
      return problem(403, "denied", "this resource's policy refuses it");
    }
    if (now() >= record.expires_at)
      return problem(408, "expired", "nobody decided in time");
    if (record.status === "pending") return waiting(record);
    // Issued once: the poll that answers it mints it.
    record.answered_at = now();
    return issue(record, narrowed(record.request.scope, record.scope));
  }

  /** Settle a request the policy waited on. A decision is made once: a second is a 409. */
  function decide(id: string, decision: AccessDecision): PendingAccess {
    const record = pending.get(id);
    if (!record) throw new AAuthError(404, "not_found", "no such request");
    if (record.status !== "pending")
      throw new AAuthError(409, "invalid_request", "already decided");
    if (now() >= record.expires_at)
      throw new AAuthError(410, "expired", "this request has expired");
    const scope = narrowed(record.request.scope, decision.scope);
    Object.assign(record, {
      status: decision.status,
      ...(decision.scope && scope ? { scope } : {}),
      ...(decision.decided_by ? { decided_by: decision.decided_by } : {}),
    });
    return record;
  }

  const metadata = () => ({
    issuer,
    jwks_uri: `${issuer}/.well-known/jwks.json`,
    auth_token_endpoint: endpoints.token,
    ...(options.name ? { name: options.name } : {}),
    ...(options.description ? { description: options.description } : {}),
  });

  /** The token endpoint and pending requests, by their path under `basePath`. */
  async function serve(request: Request, path: string | undefined) {
    if (request.method === "POST" && path === "/token")
      return requestToken(request, path);
    const id = /^\/pending\/([^/]+)$/.exec(path ?? "")?.[1];
    return request.method === "GET" && id
      ? poll(request, String(path), id)
      : undefined;
  }

  /**
   * Answer any request this Access Server serves; undefined for one it does
   * not. `pathname` is the path the Person Server addressed, when a framework
   * rewrote `request.url`.
   */
  const route = async (
    request: Request,
    pathname = new URL(request.url).pathname,
  ): Promise<Response | undefined> =>
    discovery(request, pathname, DWK, metadata, signer.jwks) ??
    serve(request, beneath(pathname, base));

  return {
    issuer,
    endpoints,
    metadata,
    jwks: () => signer.jwks,
    route,
    /** Like `route`, with AAuth errors answered as problem responses and anything else a 404. */
    handle: (request: Request, pathname?: string) =>
      answer(() => route(request, pathname)),
    decide,
    pending: (id: string) => pending.get(id),
    pendings: () => [...pending.values()],
  };
}
