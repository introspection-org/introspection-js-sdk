import type { CursorParams, IsoDate, Uuid } from "./common.js";
import type { TaskRepoRequest } from "./tasks.js";

/**
 * How an automation fires: `cron` on its schedules, `manual` by hand or once
 * at a client-set `next_trigger_at` (a one-off reminder). Open-ended: a value
 * this SDK version predates arrives as its raw string.
 */
export type AutomationTriggerType =
  "cron" | "manual" | (string & Record<never, never>);

/**
 * A platform automation kind. `null` on an {@link Automation} is a person's
 * own prompt automation. Open-ended: a value this SDK version predates
 * arrives as its raw string.
 *
 * - `observation_synthesis` — project-wide; takes no `runtime_group_id`.
 * - `observation_clustering` — clusters one runtime group's observations.
 * - `project_check_in` — the project's default check-in; runs as an agent
 *   task, so it carries a `prompt`.
 */
export type AutomationKind =
  | "observation_synthesis"
  | "observation_clustering"
  | "project_check_in"
  | (string & Record<never, never>);

/** A built-in condition evaluated before an automation runs. Open-ended. */
export type AutomationConditionType =
  | "has_new_tasks_since_last_run"
  | "last_run_issues_resolved"
  | "no_live_task_for_automation"
  | (string & Record<never, never>);

/** Outcome of one automation execution attempt. Open-ended. */
export type AutomationExecutionStatus =
  | "triggered"
  | "cancelled"
  | "failed"
  | "skipped"
  | (string & Record<never, never>);

/**
 * Why a scheduled trigger ran nothing (`introspection.automation.skipped`).
 * Open-ended. `target_busy` means the target task stayed mid-turn through
 * every retry.
 */
export type AutomationSkipReason =
  | "automation_deleted"
  | "execution_blocked"
  | "conditions_not_met"
  | "no_production_runtime"
  | "slack_not_configured"
  | "target_task_deleted"
  | "target_task_archived"
  | "target_task_unavailable"
  | "target_task_refused"
  | "target_busy"
  | (string & Record<never, never>);

/** One condition stored in an automation's metadata. */
export interface AutomationCondition {
  type: AutomationConditionType;
  runtime_group_id?: Uuid | null;
}

/**
 * The typed shape of an automation's `metadata`. The runtime group is the
 * top-level `runtime_group_id`; the server rejects it inside metadata.
 */
export interface AutomationMetadata {
  /** Repositories a task-backed automation clones. */
  repositories?: TaskRepoRequest[];
  /** Several cron expressions; `cron_schedule` is the single-schedule form. */
  cron_schedules?: string[];
  /** IANA time zone the cron schedules are evaluated in (UTC when absent). */
  timezone?: string | null;
  conditions?: AutomationCondition[];
}

/**
 * A stored automation (`/v1/automations`, Data Plane): scheduled agent work,
 * or platform work when `kind` is set.
 */
export interface Automation {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  name: string;
  description?: string | null;
  enabled: boolean;
  trigger_type: AutomationTriggerType;
  cron_schedule?: string | null;
  /** `null` for a person's own prompt automation. */
  kind?: AutomationKind | null;
  prompt?: string | null;
  metadata?: AutomationMetadata | null;
  tags: string[];
  last_triggered_at?: IsoDate | null;
  /**
   * The next slot: derived from the schedule for `cron`, client-set for a
   * one-off `manual` automation and cleared once that slot fires.
   */
  next_trigger_at?: IsoDate | null;
  /** The runtime group it runs on (or clusters); null for `observation_synthesis`. */
  runtime_group_id?: Uuid | null;
  /** The existing task each firing posts into; null creates a task per firing. */
  task_id?: Uuid | null;
  created_by_member_id?: Uuid | null;
  /** Why the scheduler will not run this automation, when it will not. */
  execution_blocked_reason?: string | null;
  /** Whether the caller may edit it. */
  can_manage: boolean;
  /**
   * `operator` for one that runs as a task (a prompt automation or
   * `project_check_in`), null otherwise.
   */
  owner_role?: string | null;
  created_at: IsoDate;
  updated_at: IsoDate;
}

/**
 * `POST /v1/automations`. A one-off reminder is a `manual` automation with a
 * future `next_trigger_at`; a `cron` automation derives its own slots and must
 * not send one.
 */
export interface AutomationCreateParams {
  name: string;
  trigger_type: AutomationTriggerType;
  description?: string;
  /** Required for `cron`. */
  cron_schedule?: string;
  /** Omit for a prompt automation, which then needs `prompt`. */
  kind?: AutomationKind;
  prompt?: string;
  /** Required unless `kind` is `observation_synthesis`, which must omit it. */
  runtime_group_id?: Uuid;
  /** An existing task each firing posts the prompt into (prompt automations only). */
  task_id?: Uuid;
  /** A one-off slot for a `manual` automation; must be in the future. */
  next_trigger_at?: IsoDate;
  metadata?: AutomationMetadata;
  /** Server default `true`. */
  enabled?: boolean;
}

/**
 * `PATCH /v1/automations/{id}`. Only the fields set are sent, and an omitted
 * field is left as it is, so nothing can be cleared. `kind` and
 * `trigger_type` are immutable; `metadata` replaces the stored value
 * wholesale.
 */
export interface AutomationUpdateParams {
  name?: string;
  description?: string;
  cron_schedule?: string;
  prompt?: string;
  /** Moves a prompt automation to another runtime group. */
  runtime_group_id?: Uuid;
  task_id?: Uuid;
  /** Schedules, moves or re-arms a `manual` automation's one-off slot; must be in the future. */
  next_trigger_at?: IsoDate;
  metadata?: AutomationMetadata;
  /** `false` pauses and keeps the slot. */
  enabled?: boolean;
}

/** Query params for `GET /v1/automations` (`limit` 1–1000, server default 100). */
export interface AutomationListParams extends CursorParams {
  kind?: AutomationKind;
  enabled?: boolean;
  /** `true`: only automations with a next slot; `false`: only those without. */
  scheduled?: boolean;
  /**
   * Only automations that post into this task. Not served until
   * introspection-cloud#3137 ships; a server without it ignores the filter.
   */
  task_id?: Uuid;
}

/**
 * Response of `POST /v1/automations/{id}/trigger`. A `skipped` status carries
 * its `reason` and records no event.
 */
export interface AutomationTriggerResponse {
  status: AutomationExecutionStatus;
  automation_id: Uuid;
  /** The task created, or posted into. */
  task_id?: Uuid | null;
  reason?: string | null;
}
