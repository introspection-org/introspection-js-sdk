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
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

import {
  discoverJwks,
  isServerIdentifier,
  verifyToken,
  AAuthTokenError,
} from "@aauth/resource";
import {
  type JWTPayload,
  createLocalJWKSet,
  decodeJwt,
  decodeProtectedHeader,
  jwtVerify,
} from "jose";
import {
  AAuthError,
  answer,
  beneath,
  discovery,
  httpsOnly,
  loadSigner,
  parseBudget,
  problem,
  readProposalSummary,
  sameScale,
  signatureError,
  verifySignature,
} from "@introspection-sdk/aauth-protocol";

import { federatedAccess } from "./federated.js";
import { MemoryStore } from "./memory-store.js";
import type {
  Agent,
  Approval,
  ApprovalKind,
  Budget,
  Decision,
  Directory,
  Mission,
  Person,
  Store,
} from "./types.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const DWK = "aauth-person.json";
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
  /** When the resource's Access Server issued it, not this Person Server: that AS. */
  access_server?: string;
}

const s256 = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("base64url");
const trim = (url: string) => url.replace(/\/+$/, "");
/** The tenant a request body names; an empty one names none. */
const tenantOf = (params: Record<string, unknown>) =>
  typeof params.tenant === "string" && params.tenant
    ? params.tenant
    : undefined;

function readBody(body: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new AAuthError(400, "invalid_request", "body must be a JSON object");
}

/** `202`: the agent polls `location` until it is decided. */
const pendingResponse = (
  location: string,
  retryAfter: number,
  requirement = "requirement=approval",
) =>
  Response.json(
    { status: "pending" },
    {
      status: 202,
      headers: {
        Location: location,
        "Retry-After": String(retryAfter),
        "Cache-Control": "no-store",
        "AAuth-Requirement": requirement,
      },
    },
  );

export type PersonServer = Awaited<ReturnType<typeof createPersonServer>>;

export async function createPersonServer(options: PersonServerOptions) {
  const issuer = trim(options.issuer);
  const base = trim(options.basePath ?? "");
  const store = options.store ?? new MemoryStore();
  const signer = await loadSigner(options.signingKey);
  const secret = options.subjectSecret ?? randomBytes(32).toString("hex");
  const fetchLike: FetchLike = httpsOnly(
    options.fetch ?? ((input, init) => fetch(input, init)),
  );
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

  // #region verify-agent
  /** The request's signature, and the agent token it presents, from a trusted agent provider. */
  async function verifyAgent(
    request: Request,
    body: string | undefined,
    path: string,
  ): Promise<{ agent: Agent; agentToken: string }> {
    const signed = await verifySignature(
      request,
      body,
      new URL(issuer).host,
      `${base}${path}`,
    );
    if (signed.keyType !== "jwt" || !signed.jwt)
      throw signatureError("unsupported_scheme", "sign with sig=jwt");
    const claims = (() => {
      try {
        return decodeJwt(signed.jwt.raw);
      } catch {
        throw signatureError("invalid_jwt", "not a JWT");
      }
    })();
    const provider = trim(String(claims.iss ?? ""));
    if (!trusted(provider))
      throw signatureError("invalid_jwt", `${provider} is not trusted here`);
    const token = await verifyToken({
      jwt: signed.jwt.raw,
      httpSignatureThumbprint: signed.thumbprint,
      resource: issuer,
      accept: ["agent"],
      fetch: fetchLike,
      now: now(),
    }).catch((err: Error) => {
      const code = err instanceof AAuthTokenError ? err.code : "invalid_jwt";
      throw signatureError(
        code === "token_expired" ? "expired_jwt" : "invalid_jwt",
        err.message,
      );
    });
    if (token.type !== "agent")
      throw signatureError("invalid_jwt", "present an agent token");
    if (token.ps !== undefined && trim(token.ps) !== issuer)
      throw new AAuthError(
        403,
        "invalid_request",
        "this agent's Person Server is another",
      );
    return {
      agent: {
        id: token.sub,
        provider,
        jkt: signed.thumbprint,
        jwk: token.cnf.jwk,
        exp: token.exp,
      },
      agentToken: signed.jwt.raw,
    };
  }

  /** A signed request's verified agent, the agent token it presented, and its JSON body. */
  async function readSigned(
    request: Request,
    path: string,
  ): Promise<{
    agent: Agent;
    agentToken: string;
    params: Record<string, unknown>;
  }> {
    const body = await request.text();
    return {
      ...(await verifyAgent(request, body, path)),
      params: readBody(body),
    };
  }

  /** The tenant a request names, and the person its agent acts for there. */
  async function requester(
    agent: Agent,
    params: Record<string, unknown>,
  ): Promise<{ tenant: string; person: Person }> {
    const named = tenantOf(params);
    const tenant = tenantFor(named);
    const person = await personFor(tenant, named, agent, params.login_hint);
    return { tenant, person };
  }

  /**
   * The person the agent acts for. Each agent key is bound to the first person
   * it names. Tokens carry the directory's tenant, else the one the agent named.
   */
  async function personFor(
    tenant: string,
    named: string | undefined,
    agent: Agent,
    loginHint: unknown,
  ): Promise<Person> {
    if (typeof loginHint !== "string" || !loginHint) {
      const bound = await store.binding(tenant, agent.jkt);
      if (!bound)
        throw new AAuthError(
          400,
          "invalid_request",
          "name the person: login_hint",
        );
      return bound;
    }
    const hinted = await options.directory.person(loginHint, tenant);
    if (!hinted)
      throw new AAuthError(
        400,
        "invalid_request",
        "not someone this Person Server speaks for",
      );
    // The directory's tenant is the person's; a request cannot move them.
    if (hinted.tenant && hinted.tenant !== tenant)
      throw new AAuthError(
        403,
        "invalid_request",
        "this person is not in that tenant",
      );
    const person =
      hinted.tenant || !named ? hinted : { ...hinted, tenant: named };
    const bound = await store.bind(tenant, agent.jkt, person);
    if (bound.id !== person.id)
      throw new AAuthError(
        403,
        "invalid_request",
        "this agent acts for another person",
      );
    return person;
  }
  // #endregion

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

  // #region missions
  /** The live mission `s256` names, if it is this agent's; the same 404 otherwise. */
  async function liveMission(
    tenant: string,
    agent: Agent,
    hash: unknown,
  ): Promise<Mission> {
    const mission =
      typeof hash === "string" ? await store.mission(tenant, hash) : undefined;
    if (!mission || mission.agent_id !== agent.id)
      throw new AAuthError(404, "mission_not_found", "no such mission");
    // The agent identifier is the provider's; the person is the key's. Another
    // key under the same identifier, bound to someone else, is a stranger.
    if ((await store.binding(tenant, agent.jkt))?.id !== mission.person.id)
      throw new AAuthError(404, "mission_not_found", "no such mission");
    if (mission.completed_at !== undefined)
      throw new AAuthError(403, "mission_terminated", "mission completed");
    if (now() >= mission.expires_at)
      throw new AAuthError(403, "mission_terminated", "mission expired");
    return mission;
  }

  async function proposeMission(
    request: Request,
    path: string,
  ): Promise<Response> {
    const { agent, params } = await readSigned(request, path);
    const { tenant, person } = await requester(agent, params);
    const description = String(params.description ?? "");
    if (!description)
      throw new AAuthError(400, "invalid_request", "describe the mission");
    const resources = (Array.isArray(params.resources) ? params.resources : [])
      .map((r) => trim(String(r)))
      .filter((r) => r.startsWith("https://"));
    return ask(tenant, "mission", agent, person, description, {
      grant: { resources },
    });
  }

  async function missionAction(
    request: Request,
    path: string,
    hash: string,
  ): Promise<Response> {
    const { agent, params } = await readSigned(request, path);
    const tenant = tenantFor(tenantOf(params));
    const mission = await liveMission(tenant, agent, hash);
    if (params.action === "update") {
      const entry = String(params.description ?? "");
      if (
        !(await store.logMission(
          tenant,
          mission.s256,
          { at: now(), entry },
          now(),
        ))
      )
        throw new AAuthError(403, "mission_terminated", "mission ended");
      return Response.json({ s256: s256(entry) });
    }
    if (params.action === "completion")
      return ask(
        tenant,
        "completion",
        agent,
        mission.person,
        String(params.summary ?? "The agent says the mission is done"),
        {
          mission_s256: mission.s256,
        },
      );
    throw new AAuthError(
      400,
      "invalid_request",
      "action is update or completion",
    );
  }
  // #endregion

  // #region auth-token
  /** A resource token, verified against its issuer's keys, binding a token this Person Server issued. */
  async function verifyResourceToken(
    agent: Agent,
    params: Record<string, unknown>,
  ) {
    const { resource_token, presented_token } = params;
    if (
      typeof resource_token !== "string" ||
      typeof presented_token !== "string"
    )
      throw new AAuthError(
        400,
        "invalid_request",
        "resource_token and presented_token are required",
      );
    const invalid = (detail: string) =>
      new AAuthError(400, "invalid_resource_token", detail);
    const presented = await jwtVerify(
      presented_token,
      createLocalJWKSet(signer.jwks),
      { issuer },
    )
      .then((r) => r.payload)
      .catch((err: Error) => {
        throw new AAuthError(
          400,
          err.name === "JWTExpired"
            ? "expired_presented_token"
            : "invalid_presented_token",
          "not a live token this Person Server issued",
        );
      });
    let unverified: JWTPayload;
    try {
      if (decodeProtectedHeader(resource_token).typ !== "aa-resource+jwt")
        throw invalid("not a resource token");
      unverified = decodeJwt(resource_token);
    } catch (err) {
      if (err instanceof AAuthError) throw err;
      throw invalid("not a JWT");
    }
    const resource = trim(String(unverified.iss ?? ""));
    const tenant = tenantFor(tenantOf(params));
    // A token that carries no tenant was issued under the default.
    const tokenTenant =
      typeof presented.tenant === "string" ? presented.tenant : defaultTenant;
    if (tokenTenant !== tenant)
      throw invalid("tenant does not match the presented token");
    // The mission's approved resources are the only issuers whose keys are fetched.
    const mission =
      typeof unverified.mission_s256 === "string"
        ? await liveMission(tenant, agent, unverified.mission_s256)
        : undefined;
    if (!mission)
      throw new AAuthError(
        403,
        "access_denied",
        "an auth token is issued only within a mission",
      );
    if (!mission.resources.includes(resource))
      throw new AAuthError(
        403,
        "access_denied",
        "this mission does not cover that resource",
      );
    const rt = await discoverJwks({
      iss: resource,
      dwk: "aauth-resource.json",
      fetch: fetchLike,
    })
      .then((jwks) =>
        jwtVerify(resource_token, createLocalJWKSet(jwks), {
          typ: "aa-resource+jwt",
          issuer: resource,
          algorithms: ["Ed25519", "ES256"],
        }),
      )
      .then((r) => r.payload)
      .catch((err: Error) => {
        throw invalid(err.message);
      });
    if (trim(String(rt.ps ?? "")) !== issuer)
      throw invalid("not for this Person Server");
    // An `aud` other than this Person Server is the resource's Access Server (four-party).
    const audience = typeof rt.aud === "string" ? trim(rt.aud) : "";
    if (audience !== issuer && !isServerIdentifier(audience))
      throw invalid("aud is neither this Person Server nor an Access Server");
    if (rt.agent_jkt !== agent.jkt)
      throw invalid("agent_jkt is not the signer");
    if (
      presented.jti !== rt.presented_jti ||
      presented.sub !== rt.sub ||
      presented.mission_s256 !== rt.mission_s256 ||
      presented.tenant !== rt.tenant ||
      presented.aud !== resource
    )
      throw invalid("does not match the presented token");
    return {
      tenant,
      rt,
      mission,
      resource,
      ...(audience === issuer ? {} : { accessServer: audience }),
    };
  }

  const proposalSummary = (rt: JWTPayload) =>
    readProposalSummary(rt, { issuer, dwk: DWK, signer, fetch: fetchLike });

  async function requestAuthToken(
    request: Request,
    path: string,
  ): Promise<Response> {
    const { agent, agentToken, params } = await readSigned(request, path);
    const { tenant, rt, mission, resource, accessServer } =
      await verifyResourceToken(agent, params);
    const budget = (() => {
      try {
        return parseBudget(rt.budget);
      } catch {
        throw new AAuthError(
          400,
          "invalid_resource_token",
          "budget is not a budget object",
        );
      }
    })();
    const grant: Record<string, unknown> = {
      aud: resource,
      sub: rt.sub,
      ...Object.fromEntries(
        (["scope", "r3_uri", "r3_s256"] as const)
          .filter((k) => k in rt)
          .map((k) => [k, rt[k]]),
      ),
      ...(budget ? { budget } : {}),
    };
    const asked = {
      mission_s256: mission.s256,
      resource,
      ...(budget ? { budget } : {}),
      grant,
    };
    // The spec passes these through to the AS only once the PS has verified them; this one
    // supports neither sub-agents nor call chaining.
    if (
      accessServer &&
      ("subagent_token" in params || "upstream_token" in params)
    )
      throw new AAuthError(
        400,
        "invalid_request",
        "this Person Server does not pass on subagent_token or upstream_token",
      );
    if (accessServer)
      return access.request(tenant, agent, mission, rt, asked, {
        access_server: accessServer,
        resource_token: String(params.resource_token),
        agent_token: agentToken,
        presented_token: String(params.presented_token),
      });
    if (!budget) return Response.json(await authToken(agent, mission, grant));
    if (mission.budget && sameScale(mission.budget, budget)) {
      const spent = await store.spend(
        tenant,
        mission.s256,
        budget.amount,
        true,
        now(),
      );
      if (spent) return Response.json(await authToken(agent, spent, grant));
    }
    return ask(
      tenant,
      "auth_token",
      agent,
      mission.person,
      String(rt.scope ?? "a request"),
      { ...asked, summary: await proposalSummary(rt) },
    );
  }
  // #endregion

  // #region ask
  async function newApproval(
    tenant: string,
    kind: ApprovalKind,
    agent: Agent,
    person: Person,
    description: string,
    extra: Partial<
      Pick<
        Approval,
        | "mission_s256"
        | "resource"
        | "budget"
        | "grant"
        | "summary"
        | "federation"
      >
    >,
  ): Promise<Approval> {
    const approver =
      (kind === "completion"
        ? undefined
        : await options.directory.approver?.(kind, person)) ?? person;
    const created = now();
    return {
      tenant,
      id: randomUUID(),
      kind,
      status: "pending",
      agent,
      person,
      approver,
      description,
      grant: {},
      ...extra,
      created_at: created,
      expires_at: created + approvalTtl,
    };
  }

  async function ask(
    ...args: Parameters<typeof newApproval>
  ): Promise<Response> {
    const approval = await newApproval(...args);
    await store.insertApproval(approval.tenant, approval);
    await options.onApproval?.(approval);
    return stillPending(approval.tenant, approval.id);
  }

  const stillPending = (tenant: string, id: string, requirement?: string) =>
    pendingResponse(endpoints.pending(tenant, id), retryAfter, requirement);

  // #endregion

  const access = federatedAccess({
    store,
    now,
    federation: { issuer, signer, fetch: fetchLike, now },
    newApproval,
    ask,
    stillPending,
    collected: () => collected(),
    proposalSummary,
    onApproval: options.onApproval,
    onIssued: options.onIssued,
  });

  // #region pending
  /** The agent polls with a signed GET; only the key that asked may read it. Results are minted now. */
  async function pendingState(
    tenant: string,
    request: Request,
    path: string,
    id: string,
  ): Promise<Response> {
    const { agent } = await verifyAgent(request, undefined, path);
    const approval = await store.approval(tenant, id);
    if (!approval || approval.agent.jkt !== agent.jkt)
      return problem(404, "not_found", "no such pending request");
    if (request.method === "DELETE") {
      if (approval.status === "pending")
        await store.transitionApproval(tenant, "pending", {
          ...approval,
          status: "denied",
          decided_by: "agent",
          decided_at: now(),
        });
      return new Response(null, { status: 204 });
    }
    if (approval.status === "denied")
      return problem(
        403,
        "denied",
        `${approval.decided_by === approval.federation?.access_server ? "The resource's Access Server" : (approval.approver.name ?? "The approver")} declined`,
      );
    if (approval.status === "pending")
      return now() >= approval.expires_at
        ? problem(408, "expired", "nobody answered in time")
        : stillPending(tenant, id);
    if (approval.status === "collected") return collected();
    if (approval.kind === "completion") return Response.json({});
    // Nothing is issued under a mission that has ended, whatever was approved.
    const mission = await liveMission(tenant, agent, approval.mission_s256);
    if (approval.kind === "mission") {
      const tokens = await Promise.all(
        mission.resources.map(async (r) => [
          r,
          (await personToken(agent, mission.person, r, mission)).person_token,
        ]),
      );
      return Response.json({
        s256: mission.s256,
        mission: Buffer.from(mission.mission).toString("base64url"),
        person_tokens: Object.fromEntries(tokens),
      });
    }
    const { federation: federated } = approval;
    if (federated)
      return access.redeem(
        tenant,
        agent,
        mission,
        { ...approval, federation: federated },
        true,
      );
    // Collected once: only the poll that collects it spends, so it spends and mints once.
    const collecting: Approval = { ...approval, status: "collected" };
    if (!(await store.transitionApproval(tenant, "approved", collecting)))
      return collected();
    const issuedUnder = await access.spendApproved(
      tenant,
      approval,
      mission,
      false,
      true,
    );
    return Response.json(await authToken(agent, issuedUnder!, approval.grant));
  }

  const collected = () =>
    problem(410, "invalid_code", "this approval's token was already collected");

  // #endregion

  // #region decide
  /**
   * Record a decision. Approving does what was asked: creates the mission or
   * completes it; an approved request is spent when its token is collected. A decision is made once: a
   * second, even a concurrent one, is a 409. `tenant` is the one the agent
   * asked under.
   */
  async function decide(
    tenant: string,
    id: string,
    decision: Decision,
  ): Promise<Approval> {
    const approval = await store.approval(tenant, id);
    if (!approval) throw new AAuthError(404, "not_found", "no such approval");
    const already = () =>
      new AAuthError(409, "invalid_request", "already decided");
    if (approval.status !== "pending") throw already();
    if (now() >= approval.expires_at)
      throw new AAuthError(410, "expired", "this approval has expired");
    if (decision.budget && approval.kind !== "mission")
      throw new AAuthError(
        400,
        "invalid_request",
        "only a mission takes a budget",
      );
    const budget = parseBudget(decision.budget);
    const decided: Approval = {
      ...approval,
      status: decision.status,
      ...(budget ? { decided_budget: budget } : {}),
      ...(decision.decided_by ? { decided_by: decision.decided_by } : {}),
      decided_at: now(),
    };
    let created: Mission | undefined;
    let existing: Mission | undefined;
    if (decision.status === "approved") {
      if (approval.kind === "mission") {
        const resources =
          (approval.grant.resources as string[] | undefined) ?? [];
        const expires_at = now() + missionTtl;
        // The approval's id makes each mission's hash its own.
        const bytes = JSON.stringify({
          approval: approval.id,
          agent: approval.agent.id,
          approved_at: new Date(now() * 1000).toISOString(),
          expires_at: new Date(expires_at * 1000).toISOString(),
          description: approval.description,
          approved_resources: resources,
          ...(budget ? { budget } : {}),
        });
        created = {
          tenant,
          s256: s256(bytes),
          mission: bytes,
          agent_id: approval.agent.id,
          person: approval.person,
          resources,
          ...(budget ? { budget } : {}),
          spent: 0,
          log: [],
          expires_at,
        };
        decided.mission_s256 = created.s256;
      } else if (approval.mission_s256) {
        existing = await store.mission(tenant, approval.mission_s256);
        if (
          !existing ||
          existing.completed_at !== undefined ||
          now() >= existing.expires_at
        )
          throw new AAuthError(
            409,
            "mission_terminated",
            "the mission has ended",
          );
      }
    }
    // The transition is the decision: what it does happens only once.
    // The mission goes in first, so a decision never points at a mission it did not create.
    if (created && !(await store.insertMission(tenant, created)))
      throw already();
    if (!(await store.transitionApproval(tenant, "pending", decided))) {
      if (created) await store.endMission(tenant, created.s256, now());
      throw already();
    }
    if (existing && approval.kind === "completion")
      await store.endMission(tenant, existing.s256, now());
    await options.onDecision?.(decided);
    return decided;
  }
  // #endregion

  // #region management
  function admitted(request: Request) {
    const header = request.headers.get("authorization") ?? "";
    if (!options.adminToken || header !== `Bearer ${options.adminToken}`)
      throw new AAuthError(
        401,
        "unauthorized",
        "the management routes need the admin token",
      );
  }

  async function terminate(tenant: string, hash: string): Promise<Mission> {
    const ended = await store.endMission(tenant, hash, now());
    if (!ended)
      throw new AAuthError(404, "mission_not_found", "no such mission");
    return ended;
  }

  async function manage(
    request: Request,
    path: string,
  ): Promise<Response | undefined> {
    const consent = /^\/consent(?:\/([^/]+)\/decision)?$/.exec(path);
    const mission = /^\/missions(?:\/([^/]+))?$/.exec(path);
    if (!consent && !mission) return undefined;
    admitted(request);
    const query = new URL(request.url).searchParams;
    const tenant = tenantFor(query.get("tenant") || undefined);
    if (consent && request.method === "GET" && !consent[1]) {
      const status = query.get("status");
      return Response.json(
        (await store.approvals(tenant)).filter(
          (a) => !status || a.status === status,
        ),
      );
    }
    if (consent?.[1] && request.method === "POST") {
      const params = readBody(await request.text());
      const verdict = params.decision ?? params.status;
      if (!["approve", "approved", "deny", "denied"].includes(String(verdict)))
        throw new AAuthError(
          400,
          "invalid_request",
          "decision is approve or deny",
        );
      return Response.json(
        await decide(tenant, consent[1], {
          status: String(verdict).startsWith("approve") ? "approved" : "denied",
          ...(params.budget !== undefined
            ? { budget: parseBudget(params.budget) }
            : {}),
          ...(typeof params.decided_by === "string"
            ? { decided_by: params.decided_by }
            : {}),
        }),
      );
    }
    if (mission && request.method === "GET") {
      if (!mission[1]) return Response.json(await store.missions(tenant));
      const found = await store.mission(tenant, mission[1]);
      return Response.json(found ?? null, { status: found ? 200 : 404 });
    }
    if (mission?.[1] && request.method === "PATCH")
      return Response.json(await terminate(tenant, mission[1]));
    return problem(405, "method_not_allowed");
  }
  // #endregion

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
    const served = discovery(request, pathname, DWK, metadata, signer.jwks);
    if (served) return served;
    const path = beneath(pathname, base);
    if (path === undefined) return undefined;
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
    return answer(() => route(request, pathname));
  }

  return {
    issuer,
    metadata,
    jwks: () => signer.jwks,
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
