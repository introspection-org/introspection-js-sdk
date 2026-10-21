import type { JWK, JWTPayload } from "jose";
import type { AuthGrant, Budget } from "@introspection-sdk/aauth-protocol";

export type { AuthGrant, Budget };

/** What an auth token from this Access Server carries besides its own claims. */
export interface AccessGrant extends AuthGrant {
  /** The Person Server the person is represented by. */
  ps: string;
  mission_s256?: string;
  tenant?: string;
}

/**
 * A Person Server's token request, once its signature and all three tokens
 * verify: who it is for, what is asked, and by which agent.
 */
export interface AccessRequest {
  /** The resource the auth token would be for: the resource token's `iss`. */
  resource: string;
  /** The Person Server that sent the request, and whose namespace `sub` is in. */
  ps: string;
  /** The person's directed identifier at the resource. */
  sub: string;
  /** The person's organisation, per OpenID Connect Enterprise; `(ps, tenant)` names it. */
  tenant?: string;
  /** The scopes asked for, space-separated. */
  scope?: string;
  mission_s256?: string;
  /** What it may spend: the budget the Person Server sent, no more than the resource token's. */
  budget?: Budget;
  /** The resource's one-line description of the call, from its R3 proposal, when it has one this server may read. */
  summary?: string;
  agent: {
    /** `aauth:local@domain`. */
    id: string;
    /** Its agent provider. */
    provider: string;
    /** JWK thumbprint of its signing key. */
    jkt: string;
  };
  /** The verified claims of each token, for whatever else the policy reads (agent posture, `account`, R3). */
  claims: {
    resource_token: JWTPayload;
    agent_token: JWTPayload;
    presented_token: JWTPayload;
  };
}

/** The resource's policy, answering each request. */
export type Verdict =
  /**
   * Issue the auth token, for `scope` when given (no broader than asked), else
   * what was asked; and for `budget` when given (no more than may be spent).
   */
  | { decision: "allow"; scope?: string; budget?: Budget }
  /** Refuse: the Person Server relays `403 denied` with `detail`. */
  | { decision: "deny"; detail?: string }
  /** Wait on someone's approval, without the person's involvement; settle it with `decide()`. */
  | { decision: "approval" }
  /** Wait on the person at `url` with `code`; settle it with `decide()` once they are done. */
  | { decision: "interaction"; url: string; code: string };

export type Policy = (request: AccessRequest) => Verdict | Promise<Verdict>;

/** `collected`: decided, and the decision handed to the Person Server, which its pending URL does once. */
export type PendingStatus = "pending" | "approved" | "denied" | "collected";

/** A request this Access Server's policy is waiting on. */
export interface PendingAccess {
  id: string;
  status: PendingStatus;
  requirement: "approval" | "interaction";
  interaction?: { url: string; code: string };
  request: AccessRequest;
  /** What the auth token is issued with, once approved. */
  grant: AccessGrant;
  /** The agent's key the auth token binds. */
  jwk: JWK;
  /** The latest the auth token may expire: its agent token's and presented token's `exp`. */
  not_after: number;
  /** Narrowed by `decide()`, when it approves for less than was asked. */
  scope?: string;
  decided_by?: string;
  created_at: number;
  expires_at: number;
}

/** What an operator answers on a pending request. */
export interface AccessDecision {
  status: "approved" | "denied";
  /** Approve for no more than this, space-separated. */
  scope?: string;
  decided_by?: string;
}

/** An auth token this Access Server issued, as `onIssued` reports it. */
export interface IssuedAccess {
  request: AccessRequest;
  jti: string;
  scope?: string;
  exp: number;
}
