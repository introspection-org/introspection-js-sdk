import type { CursorParams, IsoDate, Uuid } from "./common.js";

/**
 * A draft-hardt-aauth-budgets budget: `amount / 10**decimals` in `unit`.
 * `amount` is at most 15 digits, `unit` 1–32 characters, `decimals` 0–18.
 */
export interface AAuthBudget {
  amount: number;
  unit: string;
  decimals: number;
}

/** What an approval decides: a mission, an auth token, or a completion. */
export type ApprovalKind = "mission" | "auth_token" | "completion";

export type ApprovalStatus = "pending" | "approved" | "denied";

/** An update the agent logged under a mission. */
export interface MissionLogEntry {
  at: IsoDate;
  entry: string;
}

/**
 * A mission the hosted Person Server approved, and what it has spent
 * (`/v1/aauth/missions`).
 */
export interface Mission {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  s256: string;
  /** The mission's bytes, as hashed and returned to the agent. */
  mission: string;
  agent_id: string;
  /** The person the agent acts for. */
  member_id: Uuid;
  resources: string[];
  budget?: AAuthBudget | null;
  /** Spent so far, in the budget's unit and scale. */
  spent: number;
  log: MissionLogEntry[];
  expires_at: IsoDate;
  completed_at?: IsoDate | null;
  created_at: IsoDate;
  updated_at: IsoDate;
}

/**
 * A decision the hosted Person Server waits on, which the customer's app
 * makes (`/v1/aauth/approvals`).
 */
export interface Approval {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  kind: ApprovalKind;
  status: ApprovalStatus;
  agent_id: string;
  /** The person the agent acts for. */
  member_id: Uuid;
  mission_id?: Uuid | null;
  /** The mission's description, the booking's scope, or the completion summary. */
  description: string;
  resource?: string | null;
  /** What the resource asks for (auth token), or none. */
  budget?: AAuthBudget | null;
  /** The resource's own description of the request, from its proposal. */
  summary?: string | null;
  decided_budget?: AAuthBudget | null;
  decided_by_member_id?: Uuid | null;
  decided_at?: IsoDate | null;
  expires_at: IsoDate;
  created_at: IsoDate;
  updated_at: IsoDate;
}

/** The approver as the customer knows them: a `user_id` or an `anonymous_id`. */
export type ApproverIdentity =
  | { user_id: string; anonymous_id?: string }
  | { user_id?: string; anonymous_id: string };

/** Who decided: exactly one of a customer `identity` or a `member_id`. */
export type ApprovalDecider =
  | { identity: ApproverIdentity; member_id?: never }
  | { member_id: Uuid; identity?: never };

/**
 * `PATCH /v1/aauth/approvals/{id}` body: the approver's answer, as the
 * customer's app saw it. Approving does what the agent asked.
 */
export interface ApprovalDecision {
  status: ApprovalStatus;
  /** A mission approval's budget; none approves the mission without one. */
  budget?: AAuthBudget | null;
  /** Who decided. The app's credential is verified; the approver it names is its word. */
  decided_by: ApprovalDecider;
}

export interface ApprovalListParams extends CursorParams {
  /** Repeatable; `pending` lists only unexpired ones. */
  status?: ApprovalStatus | ApprovalStatus[];
  kind?: ApprovalKind;
  /** Only approvals for this person. */
  member_id?: Uuid;
  /** Only approvals this member decided. */
  decided_by_member_id?: Uuid;
  mission_id?: Uuid;
}

export interface MissionListParams extends CursorParams {
  /** Only missions for this person. */
  member_id?: Uuid;
}
