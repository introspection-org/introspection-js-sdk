/**
 * An AAuth Person Server (draft-hardt-oauth-aauth-protocol -11).
 *
 * It speaks for people when agents want to act for them: it verifies each
 * agent by its HTTP signature and agent token, approves missions, issues
 * person tokens and auth tokens, and weighs each auth token request against
 * its mission's budget (draft-hardt-aauth-budgets). Whatever needs a human it
 * turns into an approval, which the operator decides through `decide()` or
 * the management routes, however it reaches the person. A resource token
 * whose `aud` is the resource's own Access Server is redeemed there (four-party).
 */
import { randomBytes, randomUUID } from "node:crypto";

import { isServerIdentifier } from "@aauth/resource";
import { trace } from "@opentelemetry/api";
import {
  AAuthError,
  AAuthServer,
  type AAuthLogger,
  AccessDenied,
  authGrant,
  Denied,
  Expired,
  type FetchLike,
  httpsOnly,
  InvalidCode,
  InvalidRequest,
  InvalidToken,
  loadSigner,
  MissionNotFound,
  MissionTerminated,
  NotFound,
  parseBudget,
  pendingResponse,
  problem,
  readJsonObject,
  readProposalSummary,
  sameScale,
  ServerError,
  type Signer,
  silent,
  tokenLifetime,
  trimIdentifier,
  Unauthorized,
} from "@introspection-sdk/aauth-protocol";
import { type JWTPayload, decodeJwt, decodeProtectedHeader } from "jose";

import { AccessServerClient } from "./access-server-client.js";
import { Decisions } from "./decisions.js";
import { TokenIssuer } from "./token-issuer.js";
import { TokenVerifier } from "./token-verifier.js";
import { MemoryStore } from "./memory-store.js";
import { DEFAULT_TENANT, type PersonServerOptions } from "./options.js";
import { readDecision, s256, tenantOf } from "./requests.js";
import {
  type Agent,
  type Approval,
  type ApprovalKind,
  type Budget,
  type Decision,
  type Federation,
  fits,
  type Mission,
  Outcome,
  type Person,
  type Store,
} from "./types.js";

const tracer = trace.getTracer("@introspection-sdk/aauth-person-server");

const DWK = "aauth-person.json";

/** What an approval may be asked with, besides who and what. */
type Asked = Partial<
  Pick<
    Approval,
    | "mission_s256"
    | "resource"
    | "budget"
    | "grant"
    | "resources"
    | "summary"
    | "federation"
  >
>;

/** An approval its resource's Access Server decides too. */
type Federated = Approval & { federation: Federation };

export class PersonServer extends AAuthServer {
  readonly store: Store;
  readonly endpoints: {
    personToken: string;
    token: string;
    mission: string;
    /** Where the agent polls approval `id`, asked under `tenant`. */
    pending: (tenant: string, id: string) => string;
  };
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private readonly tokenTtl: number;
  private readonly approvalTtl: number;
  private readonly retryAfter: number;
  private readonly defaultTenant: string | undefined;
  private readonly trusted: (issuer: string) => boolean;
  private readonly client: AccessServerClient;
  private readonly verifier: TokenVerifier;
  private readonly tokens: TokenIssuer;
  private readonly decisions: Decisions;
  private readonly logger: AAuthLogger;

  private constructor(
    private readonly options: PersonServerOptions,
    signer: Signer,
  ) {
    super(
      trimIdentifier(options.issuer),
      trimIdentifier(options.basePath ?? ""),
      signer,
      DWK,
      options,
    );
    this.store = options.store ?? new MemoryStore();
    this.fetch = httpsOnly(
      options.fetch ?? ((input, init) => fetch(input, init)),
    );
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.tokenTtl = tokenLifetime(options.tokenTtlSeconds);
    this.approvalTtl = options.approvalTtlSeconds ?? 24 * 60 * 60;
    this.retryAfter = options.retryAfterSeconds ?? 5;
    this.defaultTenant = options.requireTenant
      ? undefined
      : options.defaultTenant || DEFAULT_TENANT;
    const providers = options.trustedAgentProviders;
    this.trusted =
      typeof providers === "function"
        ? providers
        : (iss: string) => providers.map(trimIdentifier).includes(iss);
    this.client = new AccessServerClient(
      this.issuer,
      signer,
      this.fetch,
      this.now,
    );
    this.logger = options.logger ?? silent;
    this.verifier = new TokenVerifier(
      this.issuer,
      this.base,
      signer,
      this.trusted,
      this.fetch,
      this.now,
    );
    this.decisions = new Decisions(
      this.store,
      this.now,
      options.missionTtlSeconds ?? 14 * 24 * 60 * 60,
      options.onDecision,
    );
    this.tokens = new TokenIssuer(
      this.issuer,
      signer,
      options.subjectSecret ?? randomBytes(32).toString("hex"),
      this.tokenTtl,
      this.now,
      options.onIssued,
    );
    const url = (path: string) => `${this.issuer}${this.base}${path}`;
    this.endpoints = {
      personToken: url("/person-token"),
      token: url("/token"),
      mission: url("/mission"),
      pending: (tenant, id) =>
        url(`/pending/${encodeURIComponent(tenant)}/${id}`),
    };
  }

  static async create(options: PersonServerOptions): Promise<PersonServer> {
    return new PersonServer(options, await loadSigner(options.signingKey));
  }

  override metadata() {
    return {
      ...this.commonMetadata(),
      person_token_endpoint: this.endpoints.personToken,
      auth_token_endpoint: this.endpoints.token,
      mission_endpoint: this.endpoints.mission,
    };
  }

  protected override async serve(
    request: Request,
    path: string | undefined,
  ): Promise<Response | undefined> {
    if (path === undefined) return undefined;
    if (request.method === "POST" && path === "/mission")
      return this.proposeMission(request, path);
    const action = /^\/mission\/([^/]+)$/.exec(path);
    if (request.method === "POST" && action?.[1])
      return this.missionAction(request, path, action[1]);
    if (request.method === "POST" && path === "/person-token")
      return this.requestPersonToken(request, path);
    if (request.method === "POST" && path === "/token")
      return this.requestAuthToken(request, path);
    const pending = /^\/pending\/(?:([^/]+)\/)?([^/]+)$/.exec(path);
    if (
      (request.method === "GET" || request.method === "DELETE") &&
      pending?.[2]
    ) {
      let named: string | undefined;
      try {
        named = pending[1] && decodeURIComponent(pending[1]);
      } catch {
        throw new InvalidRequest("not a tenant");
      }
      return this.pendingState(
        this.tenantFor(named || undefined),
        request,
        path,
        pending[2],
      );
    }
    return this.manage(request, path);
  }

  /**
   * Record a decision. Approving does what was asked: creates the mission or
   * completes it; an approved request is spent when its token is answered. A
   * decision is made once: a second, even a concurrent one, is a 409.
   * `tenant` is the one the agent asked under.
   */
  decide(tenant: string, id: string, decision: Decision): Promise<Approval> {
    return this.decisions.decide(tenant, id, decision);
  }

  async terminate(tenant: string, hash: string): Promise<Mission> {
    const ended = await this.store.endMission(tenant, hash, this.now());
    if (!ended) throw new MissionNotFound();
    return ended;
  }

  approval(tenant: string, id: string) {
    return this.store.approval(tenant, id);
  }

  approvals(tenant: string) {
    return this.store.approvals(tenant);
  }

  missions(tenant: string) {
    return this.store.missions(tenant);
  }

  mission(tenant: string, hash: string) {
    return this.store.mission(tenant, hash);
  }

  // #region federation
  /** An approved request still to be redeemed at its Access Server, or undefined. */
  async federationDue(
    tenant: string,
    id: string,
  ): Promise<Federated | undefined> {
    const approval = await this.store.approval(tenant, id);
    return approval?.federation &&
      approval.status === "approved" &&
      !approval.collected
      ? { ...approval, federation: approval.federation }
      : undefined;
  }

  /**
   * Redeem an approved request at its Access Server: its auth token, once the
   * spend lands, or a wait while the AS decides or is busy. `stored` is
   * whether the approval is saved already; one that is not is saved only if
   * it must wait.
   */
  federate(
    tenant: string,
    agent: Agent,
    mission: Mission,
    approval: Federated,
    stored: boolean,
  ): Promise<Response> {
    return tracer.startActiveSpan(
      "person_server.federate",
      { attributes: { "aauth.approval_id": approval.id } },
      async (span) => {
        try {
          const outcome = await this.exchange(approval.federation, agent.jkt);
          return await this.recordFederation(
            tenant,
            agent,
            mission,
            approval,
            outcome,
            stored,
          );
        } finally {
          span.end();
        }
      },
    );
  }

  /**
   * Record what the Access Server answered and answer the agent. Only the
   * AS's own refusal ends a saved approval, answered then as its denial: one
   * that could not be reached is asked again on the agent's next poll.
   */
  async recordFederation(
    tenant: string,
    agent: Agent,
    mission: Mission,
    approval: Federated,
    outcome: Outcome,
    stored: boolean,
  ): Promise<Response> {
    const { federation } = approval;
    const { refusal } = outcome.fields;
    this.logger.info("federation outcome recorded", {
      tenant,
      approval_id: approval.id,
      step: outcome.step,
      error: refusal?.error,
    });
    if (refusal) {
      if (stored && refusal.status >= 400 && refusal.status < 500)
        await this.store.transitionApproval(tenant, approval, {
          ...approval,
          status: "denied",
          collected: true,
          decided_by: federation.access_server,
          decided_at: this.now(),
        });
      throw new AAuthError(refusal.status, refusal.error, refusal.detail);
    }
    if (outcome.step === "pending")
      return this.wait(tenant, approval, outcome, stored);
    if (
      stored &&
      !(await this.store.transitionApproval(tenant, approval, {
        ...approval,
        collected: true,
      }))
    )
      throw new InvalidCode("this pending request was answered already");
    // What the AS granted is what is spent; it may be less than was asked.
    const budget = outcome.fields.granted ?? approval.budget;
    const spent = await this.spendApproved(
      tenant,
      approval,
      mission,
      federation.within_budget,
      stored,
      budget,
    );
    if (!spent) return this.reask(tenant, approval, stored);
    await this.options.onIssued?.({
      type: "auth_token",
      agent,
      person: spent.person,
      resource: String(approval.resource),
      mission: spent,
      ...(budget ? { budget } : {}),
      access_server: federation.access_server,
    });
    return Response.json({
      auth_token: outcome.fields.auth_token,
      expires_in: outcome.fields.expires_in,
    });
  }

  /** Ask the Access Server for an auth token, or, once it has answered `202`, poll its `Location`. */
  private async exchange(
    federation: Federation,
    agentJkt: string,
  ): Promise<Outcome> {
    const metadata = await this.client.discover(federation.access_server);
    if (metadata instanceof Outcome) return metadata;
    return federation.location
      ? this.client.poll(federation.location, federation, agentJkt, metadata)
      : this.client.request(federation, agentJkt, metadata);
  }

  /**
   * The AS is deciding: keep where it said to poll, and tell the agent to
   * wait. Or it was too busy to take the request: keep the request to send
   * again when the agent next polls.
   */
  private async wait(
    tenant: string,
    approval: Federated,
    outcome: Outcome,
    stored: boolean,
  ): Promise<Response> {
    const { federation } = approval;
    const { location, requirement } = outcome.fields;
    const waiting: Federated = location
      ? { ...approval, federation: { ...federation, location, requirement } }
      : approval;
    if (!stored) await this.store.insertApproval(tenant, waiting);
    else if (
      waiting.federation.location !== federation.location ||
      waiting.federation.requirement !== federation.requirement
    )
      await this.store.transitionApproval(tenant, approval, waiting);
    return this.stillPending(
      tenant,
      approval.id,
      waiting.federation.requirement,
      outcome.fields.retry_after,
    );
  }

  /** The budget moved since it was weighed: the approver decides, and the AS is asked again once they do. */
  private async reask(
    tenant: string,
    approval: Federated,
    collected: boolean,
  ): Promise<Response> {
    const {
      access_server,
      resource_token,
      agent_token,
      presented_token,
      budget,
    } = approval.federation;
    const asking: Approval = {
      ...approval,
      status: "pending",
      summary:
        approval.summary ??
        (await this.proposalSummary(decodeJwt(resource_token))),
      federation: {
        access_server,
        resource_token,
        agent_token,
        presented_token,
        ...(budget ? { budget } : {}),
        within_budget: false,
      },
    };
    delete asking.decided_at;
    if (!collected) await this.store.insertApproval(tenant, asking);
    else if (
      !(await this.store.transitionApproval(
        tenant,
        { status: approval.status, collected: true },
        asking,
      ))
    )
      throw new InvalidCode("this pending request was answered already");
    await this.options.onApproval?.(asking);
    return this.stillPending(tenant, asking.id);
  }

  /** A request for a resource with its own Access Server; one over what is left goes to the approver first. */
  private async requestFederated(
    tenant: string,
    agent: Agent,
    mission: Mission,
    rt: JWTPayload,
    asked: Pick<Approval, "mission_s256" | "resource" | "budget" | "grant">,
    tokens: Omit<Federation, "within_budget" | "budget">,
  ): Promise<Response> {
    const description = String(rt.scope ?? "a request");
    const sent = asked.budget ? { budget: asked.budget } : {};
    if (!fits(mission, asked.budget))
      return this.ask(
        tenant,
        "auth_token",
        agent,
        mission.person,
        description,
        {
          ...asked,
          summary: await this.proposalSummary(rt),
          federation: { ...tokens, ...sent, within_budget: false },
        },
      );
    const approval = await this.newApproval(
      tenant,
      "auth_token",
      agent,
      mission.person,
      description,
      asked,
    );
    return this.federate(
      tenant,
      agent,
      mission,
      {
        ...approval,
        status: "approved",
        decided_at: this.now(),
        federation: { ...tokens, ...sent, within_budget: true },
      },
      false,
    );
  }
  // #endregion

  /**
   * Spend an approval's budget on its mission, returning the mission it was
   * spent under; undefined when `withinBudget` and it no longer fits. A request
   * in another unit than the mission's budget is approved without spending it.
   * `collected`, when the approval was collected for this spend, puts it back
   * uncollected if the spend does not land, so a later poll can answer it.
   */
  private async spendApproved(
    tenant: string,
    approval: Approval,
    mission: Mission,
    withinBudget: boolean,
    collected: boolean,
    budget: Budget | undefined = approval.budget,
  ): Promise<Mission | undefined> {
    if (!budget || !mission.budget || !sameScale(mission.budget, budget))
      return mission;
    const restore = async () => {
      if (collected)
        await this.store
          .transitionApproval(
            tenant,
            { status: approval.status, collected: true },
            approval,
          )
          .catch(() => false);
    };
    let spent: Mission | undefined;
    try {
      spent = await this.store.spend(
        tenant,
        mission.s256,
        budget.amount,
        withinBudget,
        this.now(),
      );
    } catch (error) {
      await restore();
      throw error;
    }
    if (spent || withinBudget) return spent;
    await restore();
    throw new MissionTerminated("the mission has ended");
  }

  /** The tenant a request is under: the one it names, else the default. */
  private tenantFor(named: string | undefined): string {
    const tenant = named ?? this.defaultTenant;
    if (tenant === undefined) throw new InvalidRequest("name the tenant");
    return tenant;
  }

  // #region verify-agent
  /** A signed request's verified agent, the agent token it presented, and its JSON body. */
  private async readSigned(
    request: Request,
    path: string,
  ): Promise<{
    agent: Agent;
    agentToken: string;
    params: Record<string, unknown>;
  }> {
    const body = await request.text();
    return {
      ...(await this.verifier.agent(request, body, path)),
      params: readJsonObject(body),
    };
  }

  /** The tenant a request names, and the person its agent acts for there. */
  private async requester(
    agent: Agent,
    params: Record<string, unknown>,
  ): Promise<{ tenant: string; person: Person }> {
    const named = tenantOf(params);
    const tenant = this.tenantFor(named);
    const person = await this.personFor(
      tenant,
      named,
      agent,
      params.login_hint,
    );
    return { tenant, person };
  }

  /**
   * The person the agent acts for. Each agent key is bound to the first person
   * it names. Tokens carry the directory's tenant, else the one the agent named.
   */
  private async personFor(
    tenant: string,
    named: string | undefined,
    agent: Agent,
    loginHint: unknown,
  ): Promise<Person> {
    if (typeof loginHint !== "string" || !loginHint) {
      const bound = await this.store.binding(tenant, agent.jkt);
      if (!bound) throw new InvalidRequest("name the person: login_hint");
      return bound;
    }
    const hinted = await this.options.directory.person(loginHint, tenant);
    if (!hinted)
      throw new InvalidRequest("not someone this Person Server speaks for");
    // The directory's tenant is the person's; a request cannot move them.
    if (hinted.tenant && hinted.tenant !== tenant)
      throw new InvalidRequest("this person is not in that tenant", {
        status: 403,
      });
    const person =
      hinted.tenant || !named ? hinted : { ...hinted, tenant: named };
    const bound = await this.store.bind(tenant, agent.jkt, person);
    if (bound.id !== person.id)
      throw new InvalidRequest("this agent acts for another person", {
        status: 403,
      });
    return person;
  }
  // #endregion

  // #region tokens
  private async requestPersonToken(
    request: Request,
    path: string,
  ): Promise<Response> {
    const { agent, params } = await this.readSigned(request, path);
    const resource = trimIdentifier(String(params.resource ?? ""));
    if (!resource.startsWith("https://"))
      throw new InvalidRequest("resource is an https origin");
    const { tenant, person } = await this.requester(agent, params);
    const mission =
      params.mission_s256 === undefined
        ? undefined
        : await this.liveMission(tenant, agent, params.mission_s256);
    if (mission && mission.person.id !== person.id) throw new MissionNotFound();
    return Response.json(
      await this.tokens.personToken(agent, person, resource, mission),
    );
  }
  // #endregion

  // #region missions
  /** The live mission `s256` names, if it is this agent's; the same 404 otherwise. */
  private async liveMission(
    tenant: string,
    agent: Agent,
    hash: unknown,
  ): Promise<Mission> {
    const mission =
      typeof hash === "string"
        ? await this.store.mission(tenant, hash)
        : undefined;
    if (!mission || mission.agent_id !== agent.id) throw new MissionNotFound();
    // The agent identifier is the provider's; the person is the key's. Another
    // key under the same identifier, bound to someone else, is a stranger.
    if ((await this.store.binding(tenant, agent.jkt))?.id !== mission.person.id)
      throw new MissionNotFound();
    if (mission.completed_at !== undefined)
      throw new MissionTerminated("mission completed");
    if (this.now() >= mission.expires_at)
      throw new MissionTerminated("mission expired");
    return mission;
  }

  private async proposeMission(
    request: Request,
    path: string,
  ): Promise<Response> {
    const { agent, params } = await this.readSigned(request, path);
    const { tenant, person } = await this.requester(agent, params);
    const description = String(params.description ?? "");
    if (!description) throw new InvalidRequest("describe the mission");
    const resources = (Array.isArray(params.resources) ? params.resources : [])
      .map((r) => trimIdentifier(String(r)))
      .filter((r) => r.startsWith("https://"));
    return this.ask(tenant, "mission", agent, person, description, {
      resources,
    });
  }

  private async missionAction(
    request: Request,
    path: string,
    hash: string,
  ): Promise<Response> {
    const { agent, params } = await this.readSigned(request, path);
    const tenant = this.tenantFor(tenantOf(params));
    const mission = await this.liveMission(tenant, agent, hash);
    if (params.action === "update") {
      const entry = String(params.description ?? "");
      if (
        !(await this.store.logMission(
          tenant,
          mission.s256,
          { at: this.now(), entry },
          this.now(),
        ))
      )
        throw new MissionTerminated("mission ended");
      return Response.json({ s256: s256(entry) });
    }
    if (params.action === "completion")
      return this.ask(
        tenant,
        "completion",
        agent,
        mission.person,
        String(params.summary ?? "The agent says the mission is done"),
        { mission_s256: mission.s256 },
      );
    throw new InvalidRequest("action is update or completion");
  }
  // #endregion

  // #region auth-token
  /** A resource token, verified against its issuer's keys, binding a token this Person Server issued. */
  private async verifyResourceToken(
    agent: Agent,
    params: Record<string, unknown>,
  ) {
    const { resource_token, presented_token } = params;
    if (
      typeof resource_token !== "string" ||
      typeof presented_token !== "string"
    )
      throw new InvalidRequest(
        "resource_token and presented_token are required",
      );
    const presented = await this.verifier.presented(presented_token);
    let unverified: JWTPayload;
    try {
      if (decodeProtectedHeader(resource_token).typ !== "aa-resource+jwt")
        throw new InvalidToken("resource", "not a resource token");
      unverified = decodeJwt(resource_token);
    } catch (err) {
      if (err instanceof AAuthError) throw err;
      throw new InvalidToken("resource", "not a JWT");
    }
    const resource = trimIdentifier(String(unverified.iss ?? ""));
    const tenant = this.tenantFor(tenantOf(params));
    // A token that carries no tenant was issued under the default.
    const tokenTenant =
      typeof presented.tenant === "string"
        ? presented.tenant
        : this.defaultTenant;
    if (tokenTenant !== tenant)
      throw new InvalidToken(
        "resource",
        "tenant does not match the presented token",
      );
    // The mission's approved resources are the only issuers whose keys are fetched.
    const mission =
      typeof unverified.mission_s256 === "string"
        ? await this.liveMission(tenant, agent, unverified.mission_s256)
        : undefined;
    if (!mission)
      throw new AccessDenied("an auth token is issued only within a mission");
    if (!mission.resources.includes(resource))
      throw new AccessDenied("this mission does not cover that resource");
    // `unverified.iss` names the resource; verifying checks it signed the token.
    const rt = await this.verifier.resource(
      resource_token,
      String(unverified.iss),
    );
    if (trimIdentifier(String(rt.ps ?? "")) !== this.issuer)
      throw new InvalidToken("resource", "not for this Person Server");
    // An `aud` other than this Person Server is the resource's Access Server (four-party).
    const audience = typeof rt.aud === "string" ? trimIdentifier(rt.aud) : "";
    if (audience !== this.issuer && !isServerIdentifier(audience))
      throw new InvalidToken(
        "resource",
        "aud is neither this Person Server nor an Access Server",
      );
    if (rt.agent_jkt !== agent.jkt)
      throw new InvalidToken("resource", "agent_jkt is not the signer");
    if (
      presented.jti !== rt.presented_jti ||
      presented.sub !== rt.sub ||
      presented.mission_s256 !== rt.mission_s256 ||
      presented.tenant !== rt.tenant ||
      trimIdentifier(String(presented.aud)) !== resource
    )
      throw new InvalidToken("resource", "does not match the presented token");
    return {
      tenant,
      rt,
      mission,
      resource,
      ...(audience === this.issuer ? {} : { accessServer: audience }),
    };
  }

  private proposalSummary(rt: JWTPayload) {
    return readProposalSummary(rt, {
      issuer: this.issuer,
      dwk: DWK,
      signer: this.signer,
      fetch: this.fetch,
    });
  }

  private async requestAuthToken(
    request: Request,
    path: string,
  ): Promise<Response> {
    const { agent, agentToken, params } = await this.readSigned(request, path);
    const { tenant, rt, mission, resource, accessServer } =
      await this.verifyResourceToken(agent, params);
    let budget: Budget | undefined;
    try {
      budget = parseBudget(rt.budget);
    } catch {
      throw new InvalidToken("resource", "budget is not a budget object");
    }
    const grant = authGrant(rt, resource, budget);
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
      throw new InvalidRequest(
        "this Person Server does not pass on subagent_token or upstream_token",
      );
    if (accessServer)
      return this.requestFederated(tenant, agent, mission, rt, asked, {
        access_server: accessServer,
        resource_token: String(params.resource_token),
        agent_token: agentToken,
        presented_token: String(params.presented_token),
      });
    if (!budget)
      return Response.json(await this.tokens.authToken(agent, mission, grant));
    if (mission.budget && sameScale(mission.budget, budget)) {
      const spent = await this.store.spend(
        tenant,
        mission.s256,
        budget.amount,
        true,
        this.now(),
      );
      if (spent)
        return Response.json(await this.tokens.authToken(agent, spent, grant));
    }
    return this.ask(
      tenant,
      "auth_token",
      agent,
      mission.person,
      String(rt.scope ?? "a request"),
      { ...asked, summary: await this.proposalSummary(rt) },
    );
  }
  // #endregion

  // #region ask
  private async newApproval(
    tenant: string,
    kind: ApprovalKind,
    agent: Agent,
    person: Person,
    description: string,
    extra: Asked,
  ): Promise<Approval> {
    const approver =
      (kind === "completion"
        ? undefined
        : await this.options.directory.approver?.(kind, person)) ?? person;
    const created = this.now();
    return {
      tenant,
      id: randomUUID(),
      kind,
      status: "pending",
      agent,
      person,
      approver,
      description,
      ...extra,
      created_at: created,
      expires_at: created + this.approvalTtl,
    };
  }

  /** Save a new approval, tell whoever decides, and answer the agent `202`. */
  private async ask(
    tenant: string,
    kind: ApprovalKind,
    agent: Agent,
    person: Person,
    description: string,
    extra: Asked,
  ): Promise<Response> {
    const approval = await this.newApproval(
      tenant,
      kind,
      agent,
      person,
      description,
      extra,
    );
    await this.store.insertApproval(approval.tenant, approval);
    await this.options.onApproval?.(approval);
    return this.stillPending(approval.tenant, approval.id);
  }

  private stillPending(
    tenant: string,
    id: string,
    requirement?: string,
    wait = this.retryAfter,
  ): Response {
    return pendingResponse(
      this.endpoints.pending(tenant, id),
      wait,
      requirement,
    );
  }
  // #endregion

  // #region pending
  /**
   * The agent polls with a signed GET; only the key that asked may read it.
   * A decision is answered once, and minted then; the URL is `410` after
   * (#pending-url-security).
   */
  private async pendingState(
    tenant: string,
    request: Request,
    path: string,
    id: string,
  ): Promise<Response> {
    const { agent } = await this.verifier.agent(request, undefined, path);
    const approval = await this.store.approval(tenant, id);
    if (!approval || approval.agent.jkt !== agent.jkt)
      throw new NotFound("no such pending request");
    if (request.method === "DELETE") {
      if (approval.status === "pending")
        await this.store.transitionApproval(tenant, approval, {
          ...approval,
          status: "denied",
          decided_by: "agent",
          decided_at: this.now(),
        });
      return new Response(null, { status: 204 });
    }
    if (approval.status === "pending") {
      if (this.now() >= approval.expires_at)
        throw new Expired("nobody answered in time");
      return this.stillPending(tenant, id);
    }
    if (approval.collected)
      throw new InvalidCode("this pending request was answered already");
    const collected: Approval = { ...approval, collected: true };
    if (approval.status === "denied") {
      if (!(await this.store.transitionApproval(tenant, approval, collected)))
        throw new InvalidCode("this pending request was answered already");
      throw new Denied(`${approval.approver.name ?? "The approver"} declined`);
    }
    if (approval.kind === "completion") {
      if (!(await this.store.transitionApproval(tenant, approval, collected)))
        throw new InvalidCode("this pending request was answered already");
      return Response.json({});
    }
    // Nothing is issued under a mission that has ended, whatever was approved.
    const mission = await this.liveMission(
      tenant,
      agent,
      approval.mission_s256,
    );
    if (approval.kind === "mission")
      return this.missionApproved(tenant, agent, mission, approval);
    const due = await this.federationDue(tenant, id);
    if (due) return this.federate(tenant, agent, mission, due, true);
    // Answered once: only the poll that answers it spends, so it spends and mints once.
    if (!(await this.store.transitionApproval(tenant, approval, collected)))
      throw new InvalidCode("this pending request was answered already");
    const issuedUnder = await this.spendApproved(
      tenant,
      approval,
      mission,
      false,
      true,
    );
    if (!approval.grant) throw new ServerError("this approval grants nothing");
    return Response.json(
      await this.tokens.authToken(agent, issuedUnder!, approval.grant),
    );
  }

  /** An approved mission, collected: its bytes and a person token for each resource it covers. */
  private async missionApproved(
    tenant: string,
    agent: Agent,
    mission: Mission,
    approval: Approval,
  ): Promise<Response> {
    if (
      !(await this.store.transitionApproval(tenant, approval, {
        ...approval,
        collected: true,
      }))
    )
      throw new InvalidCode("this pending request was answered already");
    const tokens = await Promise.all(
      mission.resources.map(async (r) => [
        r,
        (await this.tokens.personToken(agent, mission.person, r, mission))
          .person_token,
      ]),
    );
    return Response.json({
      s256: mission.s256,
      mission: Buffer.from(mission.mission).toString("base64url"),
      person_tokens: Object.fromEntries(tokens),
    });
  }
  // #endregion

  // #region management
  private admitted(request: Request) {
    const header = request.headers.get("authorization") ?? "";
    if (
      !this.options.adminToken ||
      header !== `Bearer ${this.options.adminToken}`
    )
      throw new Unauthorized(
        "unauthorized",
        "the management routes need the admin token",
      );
  }

  private async manage(
    request: Request,
    path: string,
  ): Promise<Response | undefined> {
    const consent = /^\/consent(?:\/([^/]+)\/decision)?$/.exec(path);
    const mission = /^\/missions(?:\/([^/]+))?$/.exec(path);
    if (!consent && !mission) return undefined;
    this.admitted(request);
    const query = new URL(request.url).searchParams;
    const tenant = this.tenantFor(query.get("tenant") || undefined);
    if (consent && request.method === "GET" && !consent[1]) {
      const status = query.get("status");
      return Response.json(
        (await this.store.approvals(tenant)).filter(
          (a) => !status || a.status === status,
        ),
      );
    }
    if (consent?.[1] && request.method === "POST")
      return Response.json(
        await this.decide(tenant, consent[1], await readDecision(request)),
      );
    if (mission && request.method === "GET") {
      if (!mission[1]) return Response.json(await this.store.missions(tenant));
      const found = await this.store.mission(tenant, mission[1]);
      return Response.json(found ?? null, { status: found ? 200 : 404 });
    }
    if (mission?.[1] && request.method === "PATCH")
      return Response.json(await this.terminate(tenant, mission[1]));
    return problem(405, "method_not_allowed");
  }
  // #endregion
}

export const createPersonServer = (
  options: PersonServerOptions,
): Promise<PersonServer> => PersonServer.create(options);
