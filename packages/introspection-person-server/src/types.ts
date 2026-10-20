import type { JWK } from "jose";

/** A draft-hardt-aauth-budgets budget: `amount / 10 ** decimals` in `unit`. */
export interface Budget {
  amount: number;
  unit: string;
  decimals: number;
}

/** Someone this Person Server speaks for. */
export interface Person {
  /** Stable within this Person Server; never shown to a resource (it gets a directed `sub`). */
  id: string;
  name?: string;
  email?: string;
  /** The person's organisation, per OpenID Connect Enterprise; carried as `tenant`. */
  tenant?: string;
  [key: string]: unknown;
}

/** The agent a request came from, once its signature and agent token verify. */
export interface Agent {
  /** `aauth:local@domain`. */
  id: string;
  /** Its agent provider. */
  provider: string;
  /** JWK thumbprint of its signing key. */
  jkt: string;
  jwk: JWK;
  /** When its agent token expires, in seconds since the epoch. */
  exp: number;
}

export type ApprovalKind = "mission" | "auth_token" | "completion";
/** `collected`: approved, and its auth token handed out. An auth token is collected once. */
export type ApprovalStatus = "pending" | "approved" | "denied" | "collected";

/** A decision this Person Server waits on. Whoever operates it makes the decision. */
export interface Approval {
  id: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  agent: Agent;
  person: Person;
  /** Who should decide: the directory's answer, else the person. */
  approver: Person;
  /** The mission's description, the request's scope, or the completion summary. */
  description: string;
  /** The resource's own one-line description of an auth token request (its R3 proposal). */
  summary?: string;
  mission_s256?: string;
  resource?: string;
  /** What an auth token request costs, from the resource token. */
  budget?: Budget;
  /** For a mission: the resources it would cover. For an auth token: the claims it is minted with. */
  grant: Record<string, unknown>;
  /** Approving a mission sets its budget. */
  decided_budget?: Budget;
  decided_by?: string;
  /** When it was decided or withdrawn, in seconds since the epoch. */
  decided_at?: number;
  /** The tenant the agent asked under. */
  tenant?: string;
  created_at: number;
  expires_at: number;
}

export interface Mission {
  s256: string;
  /** The approved mission's bytes, as hashed and returned to the agent. */
  mission: string;
  agent_id: string;
  person: Person;
  resources: string[];
  budget?: Budget;
  spent: number;
  log: { at: number; entry: string }[];
  expires_at: number;
  completed_at?: number;
  /** The tenant the agent asked under. */
  tenant?: string;
}

/** What an operator answers. */
export interface Decision {
  status: "approved" | "denied";
  /** A mission's budget, when approving one. */
  budget?: Budget;
  /** Who decided, in the operator's own terms. */
  decided_by?: string;
}

/**
 * Where a Person Server keeps its state.
 *
 * Every method takes the request's `tenant`, the AAuth `tenant` the agent
 * named (undefined when it named none), and must keep each tenant's records
 * apart: a record is found only under the tenant it was saved with. A tenant
 * the store cannot scope, such as one in a format it does not serve, finds
 * nothing.
 *
 * Three methods must be atomic, since concurrent requests race on them:
 * `spend` checks and spends in one step, so two bookings cannot both fit in
 * what is left; `transitionApproval` changes an approval only from the status
 * it was read in, so a decision, a withdrawal or a collection happens once;
 * and `insertMission` never replaces a mission. `logMission` and `endMission`
 * change a mission in place rather than overwriting a concurrent spend.
 */
export interface Store {
  binding(tenant: string | undefined, jkt: string): Promise<string | undefined>;
  /** Bind a key to a person unless it is bound already; returns the person it is bound to. */
  bind(
    tenant: string | undefined,
    jkt: string,
    personId: string,
  ): Promise<string>;
  mission(
    tenant: string | undefined,
    s256: string,
  ): Promise<Mission | undefined>;
  /** Save a newly approved mission unless one with its hash exists; returns whether it did. */
  insertMission(tenant: string | undefined, mission: Mission): Promise<boolean>;
  /**
   * Add `amount` to a live mission's spend; with `withinBudget`, only if it
   * fits what is left. Returns the mission, or undefined when it did not.
   */
  spend(
    tenant: string | undefined,
    s256: string,
    amount: number,
    withinBudget: boolean,
    now: number,
  ): Promise<Mission | undefined>;
  /** Append to a live mission's log; returns whether it was live. */
  logMission(
    tenant: string | undefined,
    s256: string,
    entry: { at: number; entry: string },
    now: number,
  ): Promise<boolean>;
  /** Mark a mission completed at `at` unless it already is; returns it, or undefined if there is none. */
  endMission(
    tenant: string | undefined,
    s256: string,
    at: number,
  ): Promise<Mission | undefined>;
  /** The tenant's missions. */
  missions(tenant: string | undefined): Promise<Mission[]>;
  approval(
    tenant: string | undefined,
    id: string,
  ): Promise<Approval | undefined>;
  /** Save a new approval. */
  putApproval(tenant: string | undefined, approval: Approval): Promise<void>;
  /** Replace approval `next.id` with `next` only if its status is still `expected`; returns whether it did. */
  transitionApproval(
    tenant: string | undefined,
    expected: ApprovalStatus,
    next: Approval,
  ): Promise<boolean>;
  /** The tenant's approvals. */
  approvals(tenant: string | undefined): Promise<Approval[]>;
}

/** Who this Person Server speaks for, and who decides for them. */
export interface Directory {
  /**
   * The person a `login_hint` names, or undefined if this Person Server does
   * not speak for them. A person returned with a `tenant` is in that tenant
   * only: a request naming another is refused. A person returned without one
   * takes the tenant the request named, so a directory serving several
   * tenants checks `tenant` itself and returns undefined for a stranger.
   */
  person(
    loginHint: string,
    tenant?: string,
  ): Promise<Person | undefined> | Person | undefined;
  /** Who decides a request; the person themself when omitted or undefined. */
  approver?(
    kind: ApprovalKind,
    person: Person,
  ): Promise<Person | undefined> | Person | undefined;
}
