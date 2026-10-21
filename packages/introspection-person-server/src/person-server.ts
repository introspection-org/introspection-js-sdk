/**
 * An AAuth Person Server (draft-hardt-oauth-aauth-protocol -11, three-party).
 *
 * It speaks for people when agents want to act for them: it verifies each
 * agent by its HTTP signature and agent token, approves missions, issues
 * person tokens and auth tokens, and weighs each auth token request against
 * its mission's budget (draft-hardt-aauth-budgets). Whatever needs a human it
 * turns into an approval, which the operator decides through `decide()` or
 * the management routes, however it reaches the person.
 */
import { randomBytes } from "node:crypto";

import { type JWK } from "jose";

import { createAsker } from "./ask.js";
import { createAuthTokenEndpoint } from "./auth-token.js";
import { type Context, DWK, loadSigner, trim } from "./context.js";
import { createDecide } from "./decide.js";
import { AAuthError, problem } from "./errors.js";
import { createManagement } from "./management.js";
import { MemoryStore } from "./memory-store.js";
import { createMissions } from "./missions.js";
import { createPending } from "./pending.js";
import { createTokens } from "./person-token.js";
import type {
  Agent,
  Approval,
  Budget,
  Decision,
  Directory,
  Mission,
  Person,
  Store,
} from "./types.js";
import { createAgentVerifier } from "./verify-agent.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The tenant a request that names none is under, unless `defaultTenant` or `requireTenant` says otherwise. */
export const DEFAULT_TENANT = "default";

export interface PersonServerOptions {
  /** This Person Server's identifier: `https://host`, no port or path. */
  issuer: string;
  /** Who it speaks for, and who decides for them. */
  directory: Directory;
  /** Agent providers whose agents may ask (their `iss`). */
  trustedAgentProviders: readonly string[] | ((issuer: string) => boolean);
  /** PKCS#8 Ed25519 PEM. Unset, a fresh key per process. */
  signingKey?: string;
  /** Derives each person's directed `sub` per audience. Unset, a fresh secret per process. */
  subjectSecret?: string;
  /** Where state is kept; in memory by default. */
  store?: Store;
  /** The tenant a request that names none is under. Default: `DEFAULT_TENANT`. */
  defaultTenant?: string;
  /** Every request names its tenant: there is no default, and one naming none is a `400`. */
  requireTenant?: boolean;
  /** Where the routes live under the issuer, e.g. `/ps`. Default: the root. */
  basePath?: string;
  /** Called with each new approval, to reach whoever decides. */
  onApproval?: (approval: Approval) => void | Promise<void>;
  /** Called with each approval once decided. */
  onDecision?: (approval: Approval) => void | Promise<void>;
  /** Called with each token issued. */
  onIssued?: (issued: Issued) => void | Promise<void>;
  /** Bearer token for the management routes (`/consent`, `/missions`). Unset, they are off. */
  adminToken?: string;
  name?: string;
  description?: string;
  tokenTtlSeconds?: number;
  missionTtlSeconds?: number;
  approvalTtlSeconds?: number;
  retryAfterSeconds?: number;
  /** For discovery and R3 reads; global fetch by default. */
  fetch?: FetchLike;
  /** Seconds since the epoch; for tests. */
  now?: () => number;
}

/** A token this Person Server issued, as `onIssued` reports it. */
export interface Issued {
  type: "person_token" | "auth_token";
  agent: Agent;
  person: Person;
  resource: string;
  mission?: Mission;
  budget?: Budget;
}

export type PersonServer = Awaited<ReturnType<typeof createPersonServer>>;

export async function createPersonServer(options: PersonServerOptions) {
  const issuer = trim(options.issuer);
  const base = trim(options.basePath ?? "");
  const store = options.store ?? new MemoryStore();
  const signer = await loadSigner(options.signingKey);
  const secret = options.subjectSecret ?? randomBytes(32).toString("hex");
  const fetchLike: FetchLike =
    options.fetch ?? ((input, init) => fetch(input, init));
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const tokenTtl = options.tokenTtlSeconds ?? 60 * 60;
  const missionTtl = options.missionTtlSeconds ?? 14 * 24 * 60 * 60;
  const approvalTtl = options.approvalTtlSeconds ?? 24 * 60 * 60;
  const retryAfter = options.retryAfterSeconds ?? 5;
  const defaultTenant = options.requireTenant
    ? undefined
    : options.defaultTenant || DEFAULT_TENANT;
  /** The tenant a request is under: the one it names, else the default. */
  const tenantFor = (named: string | undefined): string => {
    const tenant = named ?? defaultTenant;
    if (tenant === undefined)
      throw new AAuthError(400, "invalid_request", "name the tenant");
    return tenant;
  };
  const trusted =
    typeof options.trustedAgentProviders === "function"
      ? options.trustedAgentProviders
      : (iss: string) =>
          (options.trustedAgentProviders as readonly string[])
            .map(trim)
            .includes(iss);

  const url = (path: string) => `${issuer}${base}${path}`;
  const endpoints = {
    personToken: url("/person-token"),
    token: url("/token"),
    mission: url("/mission"),
    /** Where the agent polls approval `id`, asked under `tenant`. */
    pending: (tenant: string, id: string) =>
      url(`/pending/${encodeURIComponent(tenant)}/${id}`),
  };

  const ctx: Context = {
    options,
    issuer,
    base,
    store,
    signer,
    secret,
    fetchLike,
    now,
    tokenTtl,
    missionTtl,
    approvalTtl,
    retryAfter,
    defaultTenant,
    tenantFor,
    trusted,
    endpoints,
  };
  const { verifyAgent, readSigned, requester } = createAgentVerifier(ctx);
  const { ask, stillPending } = createAsker(ctx);
  const { liveMission, proposeMission, missionAction } = createMissions(ctx, {
    readSigned,
    requester,
    ask,
  });
  const { personToken, authToken, requestPersonToken } = createTokens(ctx, {
    readSigned,
    requester,
    liveMission,
  });
  const { requestAuthToken } = createAuthTokenEndpoint(ctx, {
    readSigned,
    liveMission,
    authToken,
    ask,
  });
  const { pendingState } = createPending(ctx, {
    verifyAgent,
    liveMission,
    personToken,
    authToken,
    stillPending,
  });
  const decide: (
    tenant: string,
    id: string,
    decision: Decision,
  ) => Promise<Approval> = createDecide(ctx);
  const { terminate, manage } = createManagement(ctx, decide);

  function metadata() {
    return {
      issuer,
      ...(options.name ? { name: options.name } : {}),
      ...(options.description ? { description: options.description } : {}),
      jwks_uri: `${issuer}/.well-known/jwks.json`,
      person_token_endpoint: endpoints.personToken,
      auth_token_endpoint: endpoints.token,
      mission_endpoint: endpoints.mission,
    };
  }

  /**
   * Answer any request this Person Server serves; undefined for one it does not.
   * `pathname` is the path the agent addressed, when a framework rewrote `request.url`.
   */
  async function route(
    request: Request,
    pathname = new URL(request.url).pathname,
  ): Promise<Response | undefined> {
    if (request.method === "GET" && pathname === `/.well-known/${DWK}`)
      return Response.json(metadata());
    if (request.method === "GET" && pathname === "/.well-known/jwks.json")
      return Response.json(signer.jwks);
    if (base && !pathname.startsWith(`${base}/`)) return undefined;
    const path = pathname.slice(base.length);
    if (request.method === "POST" && path === "/mission")
      return proposeMission(request, path);
    const action = /^\/mission\/([^/]+)$/.exec(path);
    if (request.method === "POST" && action?.[1])
      return missionAction(request, path, action[1]);
    if (request.method === "POST" && path === "/person-token")
      return requestPersonToken(request, path);
    if (request.method === "POST" && path === "/token")
      return requestAuthToken(request, path);
    const pending = /^\/pending\/(?:([^/]+)\/)?([^/]+)$/.exec(path);
    if (
      (request.method === "GET" || request.method === "DELETE") &&
      pending?.[2]
    ) {
      let named: string | undefined;
      try {
        named = pending[1] && decodeURIComponent(pending[1]);
      } catch {
        throw new AAuthError(400, "invalid_request", "not a tenant");
      }
      return pendingState(
        tenantFor(named || undefined),
        request,
        path,
        pending[2],
      );
    }
    return manage(request, path);
  }

  /** Like `route`, with AAuth errors answered as problem responses and anything else a 404. */
  async function handle(
    request: Request,
    pathname?: string,
  ): Promise<Response> {
    try {
      return (await route(request, pathname)) ?? problem(404, "not_found");
    } catch (err) {
      if (err instanceof AAuthError)
        return problem(err.status, err.error, err.message, err.headers);
      return problem(500, "server_error", (err as Error).message);
    }
  }

  return {
    issuer,
    metadata,
    jwks: (): { keys: JWK[] } => signer.jwks,
    endpoints,
    handle,
    route,
    decide,
    terminate,
    approval: (tenant: string, id: string) => store.approval(tenant, id),
    approvals: (tenant: string) => store.approvals(tenant),
    missions: (tenant: string) => store.missions(tenant),
    mission: (tenant: string, hash: string) => store.mission(tenant, hash),
    store,
  };
}
