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

import {
  type AAuthLogger,
  AAuthServer,
  type Budget,
  Denied,
  Expired,
  type FetchLike,
  httpsOnly,
  InvalidCode,
  InvalidRequest,
  InvalidToken,
  loadSigner,
  NotFound,
  parseBudget,
  pendingResponse,
  readProposalSummary,
  type Signer,
  silent,
  tokenLifetime,
  trimIdentifier,
  Unauthorized,
  verifySignature,
} from "@introspection-sdk/aauth-protocol";
import type { JWK } from "jose";

import { bounded, grantFor, lowered, narrowed } from "./grants.js";
import type { AccessServerOptions } from "./options.js";
import { readTokens, requirementHeader } from "./requests.js";
import { TokenVerifier } from "./token-verifier.js";
import type { AccessDecision, AccessRequest, PendingAccess } from "./types.js";

const DWK = "aauth-access.json";

/** A verified request, as the policy is asked and an auth token issued from it. */
type Asked = Pick<PendingAccess, "request" | "grant" | "jwk" | "not_after">;

export class AccessServer extends AAuthServer {
  readonly endpoints: { token: string; pending: (id: string) => string };
  private readonly fetch: FetchLike;
  private readonly now: () => number;
  private readonly tokenTtl: number;
  private readonly pendingTtl: number;
  private readonly retryAfter: number;
  private readonly personServers: string[];
  private readonly verifier: TokenVerifier;
  private readonly logger: AAuthLogger;
  private readonly waitingOn = new Map<string, PendingAccess>();

  private constructor(
    private readonly options: AccessServerOptions,
    signer: Signer,
  ) {
    super(
      trimIdentifier(options.issuer),
      trimIdentifier(options.basePath ?? ""),
      signer,
      DWK,
      options,
    );
    this.fetch = httpsOnly(
      options.fetch ?? ((input, init) => fetch(input, init)),
    );
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.tokenTtl = tokenLifetime(options.tokenTtlSeconds);
    this.pendingTtl = options.pendingTtlSeconds ?? 24 * 60 * 60;
    this.retryAfter = options.retryAfterSeconds ?? 5;
    this.personServers = options.personServers.map(trimIdentifier);
    this.verifier = new TokenVerifier(
      this.issuer,
      options.resources.map(trimIdentifier),
      options.agentProviders.map(trimIdentifier),
      this.fetch,
      this.now,
    );
    this.logger = options.logger ?? silent;
    const url = (path: string) => `${this.issuer}${this.base}${path}`;
    this.endpoints = {
      token: url("/token"),
      pending: (id) => url(`/pending/${id}`),
    };
  }

  static async create(options: AccessServerOptions): Promise<AccessServer> {
    if (!trimIdentifier(options.issuer).startsWith("https://"))
      throw new Error("issuer must be an https origin");
    return new AccessServer(
      options,
      await loadSigner(options.signingKey, options.kid),
    );
  }

  override metadata() {
    return {
      ...this.commonMetadata(),
      auth_token_endpoint: this.endpoints.token,
    };
  }

  protected override async serve(
    request: Request,
    path: string | undefined,
  ): Promise<Response | undefined> {
    if (request.method === "POST" && path === "/token")
      return this.requestToken(request, path);
    const id = /^\/pending\/([^/]+)$/.exec(path ?? "")?.[1];
    return request.method === "GET" && id
      ? this.poll(request, String(path), id)
      : undefined;
  }

  /** Settle a request the policy waited on. A decision is made once: a second is a 409. */
  decide(id: string, decision: AccessDecision): PendingAccess {
    const record = this.waitingOn.get(id);
    if (!record) throw new NotFound("no such request");
    if (record.status !== "pending")
      throw new InvalidRequest("already decided", { status: 409 });
    if (this.now() >= record.expires_at)
      throw new Expired("this request has expired", { status: 410 });
    const scope = narrowed(record.request.scope, decision.scope);
    Object.assign(record, {
      status: decision.status,
      ...(decision.scope && scope ? { scope } : {}),
      ...(decision.decided_by ? { decided_by: decision.decided_by } : {}),
    });
    return record;
  }

  pending(id: string): PendingAccess | undefined {
    return this.waitingOn.get(id);
  }

  pendings(): PendingAccess[] {
    return [...this.waitingOn.values()];
  }

  /** The Person Server that signed a request, by `sig=jwks_uri` under its `aauth-person.json`. */
  private async personServer(
    request: Request,
    body: string | undefined,
    path: string,
  ): Promise<string> {
    const named = /jwks_uri;(?:[^,]*;)?id="([^"]+)"/.exec(
      request.headers.get("signature-key") ?? "",
    )?.[1];
    // Checked before verifying, since verifying fetches its keys.
    if (!named || !this.personServers.includes(named))
      throw Unauthorized.signature(
        "invalid_signature",
        "sign as a Person Server this Access Server takes requests from",
      );
    const signed = await verifySignature(
      request,
      body,
      new URL(this.issuer).host,
      `${this.base}${path}`,
    );
    if (
      signed.keyType !== "jwks_uri" ||
      signed.jwks_uri?.dwk !== "aauth-person.json"
    )
      throw Unauthorized.signature(
        "unsupported_scheme",
        "a Person Server signs with sig=jwks_uri and its aauth-person.json",
      );
    return signed.jwks_uri.id;
  }

  /** The request, verified, as the policy sees it. */
  private async readRequest(ps: string, body: string): Promise<Asked> {
    const tokens = readTokens(body);
    const rt = await this.verifier.resourceToken(tokens.resource_token, ps);
    const agent = await this.verifier.agentToken(tokens.agent_token, rt, ps);
    const presented = await this.verifier.presentedToken(
      tokens.presented_token,
      rt,
      ps,
    );
    const summary = await readProposalSummary(rt, {
      issuer: this.issuer,
      dwk: DWK,
      signer: this.signer,
      fetch: this.fetch,
    });
    let asked: Budget | undefined;
    try {
      asked = parseBudget(rt.budget);
    } catch {
      throw new InvalidToken("resource", "its budget is not a budget");
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
  private async issue(
    issuing: Asked,
    scope: string | undefined,
  ): Promise<Response> {
    const iat = this.now();
    const exp = Math.min(iat + this.tokenTtl, issuing.not_after);
    const jti = randomUUID();
    const auth_token = await this.signer.sign(
      {
        iss: this.issuer,
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
    await this.options.onIssued?.({
      request: issuing.request,
      jti,
      exp,
      ...(scope ? { scope } : {}),
    });
    return Response.json({ auth_token, expires_in: exp - iat });
  }

  private waiting(record: PendingAccess): Response {
    return pendingResponse(
      this.endpoints.pending(record.id),
      this.retryAfter,
      requirementHeader(record.interaction),
    );
  }

  /** #as-token-endpoint: a Person Server's signed request for an auth token. */
  private async requestToken(request: Request, path: string) {
    const body = await request.text();
    const ps = await this.personServer(request, body, path);
    const asked = await this.readRequest(ps, body);
    const verdict = await this.options.policy(asked.request);
    this.logger.info("access request decided", {
      resource: asked.request.resource,
      ps,
      tenant: asked.request.tenant,
      decision: verdict.decision,
    });
    if (verdict.decision === "allow")
      return this.issue(
        {
          ...asked,
          grant: lowered(asked.grant, asked.request.budget, verdict.budget),
        },
        narrowed(asked.request.scope, verdict.scope),
      );
    if (verdict.decision === "deny")
      throw new Denied(verdict.detail ?? "this resource's policy refuses it");
    const interaction =
      verdict.decision === "interaction"
        ? { url: verdict.url, code: verdict.code }
        : undefined;
    requirementHeader(interaction);
    const created = this.now();
    const record: PendingAccess = {
      id: randomUUID(),
      status: "pending",
      requirement: verdict.decision,
      ...(interaction ? { interaction } : {}),
      ...asked,
      created_at: created,
      expires_at: Math.min(created + this.pendingTtl, asked.not_after),
    };
    this.waitingOn.set(record.id, record);
    await this.options.onPending?.(record);
    return this.waiting(record);
  }

  /**
   * The Person Server polls a pending request with a signed GET; only the one
   * that asked may. A decision is answered once; the URL is `410` after
   * (#pending-url-security).
   */
  private async poll(request: Request, path: string, id: string) {
    const ps = await this.personServer(request, undefined, path);
    const record = this.waitingOn.get(id);
    if (!record || record.request.ps !== ps)
      throw new NotFound("no such pending request");
    if (record.collected)
      throw new InvalidCode("this request was answered already");
    if (record.status === "denied") {
      record.collected = true;
      throw new Denied("this resource's policy refuses it");
    }
    if (this.now() >= record.expires_at)
      throw new Expired("nobody decided in time");
    if (record.status === "pending") return this.waiting(record);
    // Issued once: the poll that answers it mints it.
    record.collected = true;
    return this.issue(record, narrowed(record.request.scope, record.scope));
  }
}

export const createAccessServer = (
  options: AccessServerOptions,
): Promise<AccessServer> => AccessServer.create(options);
