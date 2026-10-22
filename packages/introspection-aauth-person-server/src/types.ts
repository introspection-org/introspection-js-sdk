import type { JWK } from "jose";

import {
  type AuthGrant,
  type Budget,
  sameScale,
} from "@introspection-sdk/aauth-protocol";

export type { AuthGrant, Budget };

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
/** What was decided. Whether the agent has the answer is `collected`. */
export type ApprovalStatus = "pending" | "approved" | "denied";

/** The state a transition expects an approval still to be in: its decision, and whether it was collected. */
export type ApprovalState = Pick<Approval, "status" | "collected">;

/**
 * An auth token request the resource's own Access Server decides too (draft
 * -11 four-party): the resource token's `aud` is the AS, and the Person Server
 * redeems it there with the three tokens below.
 */
export interface Federation {
  /** The Access Server: the verified resource token's `aud`. */
  access_server: string;
  resource_token: string;
  agent_token: string;
  presented_token: string;
  /**
   * Whether the request must fit what is left of the mission's budget when it
   * is spent: true when the mission covered it, false once a person approved it.
   */
  within_budget: boolean;
  /** The `budget` sent to the AS (draft-hardt-aauth-budgets #as-token-endpoint): the resource token's. */
  budget?: Budget;
  /** Where the Access Server said to poll, once it answered `202`. */
  location?: string;
  /** The Access Server's `AAuth-Requirement` while it decides, relayed to the agent. */
  requirement?: string;
}

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
  /** For a mission: the resources it would cover. */
  resources?: string[];
  /** For an auth token: the claims it is minted with. */
  grant?: AuthGrant;
  /** Set when the resource's Access Server decides too; then the approval is `approved` once the person's side is. */
  federation?: Federation;
  /** Approving a mission sets its budget. */
  decided_budget?: Budget;
  decided_by?: string;
  /** When it was decided or withdrawn, in seconds since the epoch. */
  decided_at?: number;
  /**
   * Whether its pending URL gave the agent the decision (#pending-url-security):
   * a decision is answered once, and an auth token is minted then.
   */
  collected?: boolean;
  /** The tenant it was asked under: the one the agent named, else the default. */
  tenant: string;
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
  /** The tenant it was asked under: the one the agent named, else the default. */
  tenant: string;
}

/** Whether a request costing `budget` fits what is left of `mission`'s budget. */
export const fits = (mission: Mission, budget: Budget | undefined): boolean =>
  !budget ||
  (!!mission.budget &&
    sameScale(mission.budget, budget) &&
    mission.spent + budget.amount <= mission.budget.amount);

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
 * named or else the server's default, and must keep each tenant's records
 * apart: a record is found only under the tenant it was saved with. A tenant
 * the store cannot scope, such as one in a format it does not serve, finds
 * nothing.
 *
 * Three methods must be atomic, since concurrent requests race on them:
 * `spend` checks and spends in one step, so two bookings cannot both fit in
 * what is left; `transitionApproval` changes an approval only from the state
 * it was read in, so a decision, a withdrawal or an answer happens once;
 * and `insertMission` never replaces a mission. `logMission` and `endMission`
 * change a mission in place rather than overwriting a concurrent spend.
 */
export interface Store {
  /** The person an agent key is bound to. */
  binding(tenant: string, jkt: string): Promise<Person | undefined>;
  /** Bind a key to a person unless it is bound already; returns whoever it is bound to. */
  bind(tenant: string, jkt: string, person: Person): Promise<Person>;
  mission(tenant: string, s256: string): Promise<Mission | undefined>;
  /** Save a newly approved mission unless one with its hash exists; returns whether it did. */
  insertMission(tenant: string, mission: Mission): Promise<boolean>;
  /**
   * Add `amount` to a live mission's spend; with `withinBudget`, only if it
   * fits what is left. Returns the mission, or undefined when it did not.
   */
  spend(
    tenant: string,
    s256: string,
    amount: number,
    withinBudget: boolean,
    now: number,
  ): Promise<Mission | undefined>;
  /** Append to a live mission's log; returns whether it was live. */
  logMission(
    tenant: string,
    s256: string,
    entry: { at: number; entry: string },
    now: number,
  ): Promise<boolean>;
  /** Mark a mission completed at `at` unless it already is; returns it, or undefined if there is none. */
  endMission(
    tenant: string,
    s256: string,
    at: number,
  ): Promise<Mission | undefined>;
  /** The tenant's missions. */
  missions(tenant: string): Promise<Mission[]>;
  approval(tenant: string, id: string): Promise<Approval | undefined>;
  /** Save a new approval. */
  insertApproval(tenant: string, approval: Approval): Promise<void>;
  /**
   * Replace approval `next.id` with `next` only if its `status` and
   * `collected` are still `expected`'s (an absent `collected` is false);
   * returns whether it did.
   */
  transitionApproval(
    tenant: string,
    expected: ApprovalState,
    next: Approval,
  ): Promise<boolean>;
  /** The tenant's approvals. */
  approvals(tenant: string): Promise<Approval[]>;
}

/** Who this Person Server speaks for, and who decides for them. */
export interface Directory {
  /**
   * The person a `login_hint` names, or undefined if this Person Server does
   * not speak for them. `tenant` is the one the request is under: the one the
   * agent named, else the default. A person returned with a `tenant` is in
   * that tenant alone, and a request under any other is refused. A person
   * returned without one takes the request's, so a directory serving several
   * tenants checks `tenant` itself and returns undefined for a stranger.
   */
  person(
    loginHint: string,
    tenant: string,
  ): Promise<Person | undefined> | Person | undefined;
  /** Who decides a request; the person themself when omitted or undefined. */
  approver?(
    kind: ApprovalKind,
    person: Person,
  ): Promise<Person | undefined> | Person | undefined;
}

/** What one exchange with an Access Server came to. */
export type Step = "issued" | "pending" | "refused";

/** Seconds between polls when the Access Server sends no usable `Retry-After`, and the bounds on it. */
const DEFAULT_DELAY = 5;
const MIN_DELAY = 1;
const MAX_DELAY = 300;

/** The Access Server's refusal, relayed to the agent with its own status and code. */
export interface Refusal {
  status: number;
  error: string;
  detail: string;
}

/** What an exchange with an Access Server came to. */
export class Outcome {
  constructor(
    readonly step: Step,
    readonly fields: {
      auth_token?: string;
      expires_in?: number;
      /** The budget the Access Server granted, no more than the one sent; spent in its place. */
      granted?: Budget;
      /** Where to poll next; on a pending outcome, undefined sends the request again. */
      location?: string;
      /** Its `AAuth-Requirement`, relayed to the agent. */
      requirement?: string;
      retry_after?: number;
      refusal?: Refusal;
    } = {},
  ) {}

  static refused(status: number, error: string, detail: string): Outcome {
    return new Outcome("refused", { refusal: { status, error, detail } });
  }

  /** `as_unreachable`: no verifiable answer from the Access Server. */
  static unreachable(detail: string): Outcome {
    return Outcome.refused(502, "as_unreachable", detail);
  }

  /** `Retry-After`, 5 seconds when absent; never a hot loop, never a stall. */
  pollDelay(): number {
    const after = this.fields.retry_after;
    return after === undefined
      ? DEFAULT_DELAY
      : Math.min(Math.max(after, MIN_DELAY), MAX_DELAY);
  }
}
