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
  beneath,
  discovery,
  loadSigner,
  problem,
  readProposalSummary,
  signatureError,
  verifySignature,
} from "@introspection-sdk/person-server";
import type { JWK, JWTPayload } from "jose";

import type {
  AccessDecision,
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
const MAX_TOKEN_TTL = 60 * 60;

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

const trim = (url: string) => url.replace(/\/+$/, "");
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

function readBudget(value: unknown): Budget | undefined {
  const { amount, unit, decimals } = (value ?? {}) as Partial<Budget>;
  return typeof amount === "number" &&
    typeof unit === "string" &&
    typeof decimals === "number"
    ? { amount, unit, decimals }
    : undefined;
}

function readTokens(body: string) {
  let params: Record<string, unknown> = {};
  try {
    params = (JSON.parse(body) ?? {}) as Record<string, unknown>;
  } catch {
    // answered below
  }
  const { resource_token, agent_token, presented_token } = params;
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
  return { resource_token, agent_token, presented_token };
}

/** The claims an auth token for `rt` carries besides its own, copied from the resource token. */
function grantFor(rt: JWTPayload): Record<string, unknown> {
  return {
    aud: rt.iss,
    ps: rt.ps,
    sub: rt.sub,
    ...Object.fromEntries(
      (
        ["account", "mission_s256", "tenant", "r3_uri", "r3_s256"] as const
      ).flatMap((k) => (rt[k] === undefined ? [] : [[k, rt[k]]])),
    ),
  };
}

export type AccessServer = Awaited<ReturnType<typeof createAccessServer>>;

export async function createAccessServer(options: AccessServerOptions) {
  const issuer = trim(options.issuer);
  if (!issuer.startsWith("https://"))
    throw new Error("issuer must be an https origin");
  const base = trim(options.basePath ?? "");
  const signer = await loadSigner(options.signingKey, options.kid);
  const fetchLike: FetchLike =
    options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const tokenTtl = Math.min(
    options.tokenTtlSeconds ?? MAX_TOKEN_TTL,
    MAX_TOKEN_TTL,
  );
  const pendingTtl = options.pendingTtlSeconds ?? 24 * 60 * 60;
  const retryAfter = options.retryAfterSeconds ?? 5;
  const personServers = options.personServers.map(trim);
  const verifier: Verifier = {
    issuer,
    resources: options.resources.map(trim),
    agentProviders: options.agentProviders.map(trim),
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
    const budget = readBudget(rt.budget);
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
      grant: grantFor(rt),
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
          "AAuth-Requirement": buildRequirementHeader(
            record.interaction
              ? { requirement: "interaction", ...record.interaction }
              : { requirement: "approval" },
          ),
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
      return issue(asked, narrowed(asked.request.scope, verdict.scope));
    if (verdict.decision === "deny")
      return problem(
        403,
        "denied",
        verdict.detail ?? "this resource's policy refuses it",
      );
    const created = now();
    const record: PendingAccess = {
      id: randomUUID(),
      status: "pending",
      requirement: verdict.decision,
      ...(verdict.decision === "interaction"
        ? { interaction: { url: verdict.url, code: verdict.code } }
        : {}),
      ...asked,
      created_at: created,
      expires_at: Math.min(created + pendingTtl, asked.not_after),
    };
    pending.set(record.id, record);
    await options.onPending?.(record);
    return waiting(record);
  }

  /** The Person Server polls a pending request with a signed GET; only the one that asked may. */
  async function poll(request: Request, path: string, id: string) {
    const ps = await personServer(request, undefined, path);
    const record = pending.get(id);
    if (!record || record.request.ps !== ps)
      return problem(404, "not_found", "no such pending request");
    if (record.status === "denied")
      return problem(403, "denied", "this resource's policy refuses it");
    if (record.status === "collected")
      return problem(
        410,
        "invalid_request",
        "its auth token was issued already",
      );
    if (now() >= record.expires_at)
      return problem(408, "expired", "nobody decided in time");
    if (record.status === "pending") return waiting(record);
    // Issued once: the poll that collects it mints it.
    record.status = "collected";
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
