import type { CursorParams, IsoDate, Uuid } from "./common.js";
import type { TaskRepoRequest } from "./tasks.js";

/**
 * How a routine fires: `cron` on its schedules, `manual` by hand or once
 * at a client-set `next_trigger_at` (a one-off reminder). Open-ended: a value
 * this SDK version predates arrives as its raw string.
 */
export type RoutineTriggerType =
  "cron" | "manual" | (string & Record<never, never>);

/**
 * A platform routine kind. `null` on a {@link Routine} is a person's
 * own prompt routine. Open-ended: a value this SDK version predates
 * arrives as its raw string.
 *
 * - `observation_synthesis` — project-wide; takes no `runtime_group_id`.
 * - `observation_clustering` — clusters one runtime group's observations.
 * - `project_check_in` — the project's default check-in; runs as an agent
 *   task, so it carries a `prompt`.
 */
export type RoutineKind =
  | "observation_synthesis"
  | "observation_clustering"
  | "project_check_in"
  | (string & Record<never, never>);

/** A built-in condition evaluated before a routine runs. Open-ended. */
export type RoutineConditionType =
  | "has_new_tasks_since_last_run"
  | "last_run_issues_resolved"
  | "no_live_task_for_routine"
  | (string & Record<never, never>);

/** Outcome of one routine execution attempt. Open-ended. */
export type RoutineExecutionStatus =
  | "triggered"
  | "cancelled"
  | "failed"
  | "skipped"
  | (string & Record<never, never>);

/**
 * Why a scheduled slot or an event delivery ran nothing
 * (`introspection.routines.skipped`). Open-ended. `target_busy` means the
 * target task stayed mid-turn through every retry; `trigger_busy` that an
 * event trigger's previous run was still going.
 */
export type RoutineSkipReason =
  | "routine_deleted"
  | "execution_blocked"
  | "conditions_not_met"
  | "no_production_runtime"
  | "slack_not_configured"
  | "target_task_deleted"
  | "target_task_archived"
  | "target_task_unavailable"
  | "target_task_refused"
  | "target_busy"
  | "trigger_busy"
  | (string & Record<never, never>);

/**
 * What started a routine run, stamped on its task as
 * `metadata.trigger_source`: its schedule, a manual `trigger(id)`, or an
 * event trigger. Open-ended.
 */
export type RoutineRunSource =
  "scheduled" | "manual" | "trigger" | (string & Record<never, never>);

/**
 * What an event trigger listens to: an organization integration (Slack,
 * GitHub), or a project connector named by `connector_slug` (a `webhook`
 * connector). Open-ended.
 */
export type RoutineTriggerSource =
  "integration" | "connector" | (string & Record<never, never>);

/**
 * The provider of a trigger's events. `slack` and `github` are integration
 * sources, `webhook` a connector source; the server refuses `linear` until its
 * events are forwarded. Open-ended.
 */
export type RoutineTriggerProvider =
  "slack" | "linear" | "github" | "webhook" | (string & Record<never, never>);

/**
 * A trigger's filter: every key set must contain the event's value for it,
 * and a key set names at least one value. Which keys a provider takes:
 *
 * - `slack` — `channel_ids` (required for `slack.message.posted`), `emoji`.
 * - `linear` — `team_ids`, `to_states`.
 * - `github` — `repository_ids`, `branches`.
 * - `webhook` — `payload_fields`: a top-level key of the JSON body and the
 *   values its scalar may hold (a string as given, any other scalar as JSON,
 *   such as `"true"` or `"3"`).
 */
export interface RoutineTriggerFilter {
  channel_ids?: string[] | null;
  emoji?: string[] | null;
  team_ids?: string[] | null;
  to_states?: string[] | null;
  repository_ids?: string[] | null;
  branches?: string[] | null;
  /** At most 20 keys. */
  payload_fields?: Record<string, string[]> | null;
}

/**
 * One trigger in a routine's `triggers` on create or update.
 *
 * `event_types` (1–50) are `{provider}.{object}.{action}` names from the
 * catalogue, such as `github.pull_request.opened`; a `webhook` connector's are
 * the JSON body's string `type` (else `webhook.received`), or `*` alone for
 * every one. `parameters` maps a name (lowercase letters, digits and `_`,
 * starting with a letter, up to 40; at most 20) to an RFC 6901 JSON pointer
 * into the event's body: the run receives the values as `parameters.json`,
 * and each `@parameters.<name>` in the prompt becomes that value as JSON
 * (`null` when it resolves to nothing).
 */
export interface RoutineTriggerSpec {
  /** On update: an existing trigger of this routine to keep. Never on create. */
  id?: Uuid;
  /** Server default `integration`. */
  source?: RoutineTriggerSource;
  provider: RoutineTriggerProvider;
  /** The project connector's slug; set for a `connector` source, and only then. */
  connector_slug?: string;
  event_types: string[];
  filter?: RoutineTriggerFilter;
  /** `{name: json_pointer}`, such as `{ customer_id: "/data/customer" }`. */
  parameters?: Record<string, string>;
  /** Server default `true`. */
  enabled?: boolean;
}

/** A stored trigger, as a {@link Routine}'s `triggers` returns it. */
export interface RoutineTrigger {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  routine_id: Uuid;
  source: RoutineTriggerSource;
  provider: RoutineTriggerProvider;
  connector_slug?: string | null;
  event_types: string[];
  filter: RoutineTriggerFilter;
  parameters: Record<string, string>;
  enabled: boolean;
  created_at: IsoDate;
  updated_at: IsoDate;
}

/**
 * The event trigger a run or a skip answered, on the routine events and, for
 * a `trigger`-sourced run, its task's `metadata.routine_trigger`.
 */
export interface RoutineTriggerEventRef {
  trigger_id: Uuid;
  /** The delivered event's type, such as `github.pull_request.opened`. */
  event_type: string;
  /** The provider event's identity within its source; a redelivery repeats it. */
  delivery_id: string;
}

/**
 * The platform keys a routine run stamps on its task's `metadata` (cast
 * `task.metadata` to read them). Clients cannot set them.
 */
export interface RoutineTaskMetadata {
  trigger_source?: RoutineRunSource;
  /** Set on a `trigger`-sourced run. */
  routine_trigger?: RoutineTriggerEventRef;
  /**
   * Each `@parameters.<name>` the prompt referenced that had no value and so
   * received `null`.
   */
  unresolved_parameters?: string[];
}

/** One condition stored in a routine's metadata. */
export interface RoutineCondition {
  type: RoutineConditionType;
  runtime_group_id?: Uuid | null;
}

/**
 * The typed shape of a routine's `metadata`. The runtime group is the
 * top-level `runtime_group_id`; the server rejects it inside metadata.
 */
export interface RoutineMetadata {
  /** Repositories a task-backed routine clones. */
  repositories?: TaskRepoRequest[];
  /** Several cron expressions; `cron_schedule` is the single-schedule form. */
  cron_schedules?: string[];
  /** IANA time zone the cron schedules are evaluated in (UTC when absent). */
  timezone?: string | null;
  conditions?: RoutineCondition[];
}

/**
 * A stored routine (`/v1/routines`, Data Plane): scheduled agent work,
 * or platform work when `kind` is set.
 */
export interface Routine {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  name: string;
  description?: string | null;
  enabled: boolean;
  trigger_type: RoutineTriggerType;
  cron_schedule?: string | null;
  /** `null` for a person's own prompt routine. */
  kind?: RoutineKind | null;
  prompt?: string | null;
  metadata?: RoutineMetadata | null;
  tags: string[];
  last_triggered_at?: IsoDate | null;
  /**
   * The next slot: derived from the schedule for `cron`, client-set for a
   * one-off `manual` routine and cleared once that slot fires.
   */
  next_trigger_at?: IsoDate | null;
  /** The runtime group it runs on (or clusters); null for `observation_synthesis`. */
  runtime_group_id?: Uuid | null;
  /** The existing task each firing posts into; null creates a task per firing. */
  task_id?: Uuid | null;
  created_by_member_id?: Uuid | null;
  /** Why the scheduler will not run this routine, when it will not. */
  execution_blocked_reason?: string | null;
  /** Whether the caller may edit it. */
  can_manage: boolean;
  /** The events that start a run, beside the schedule and `trigger(id)`. */
  triggers: RoutineTrigger[];
  /**
   * `operator` for one that runs as a task (a prompt routine or
   * `project_check_in`), null otherwise.
   */
  owner_role?: string | null;
  created_at: IsoDate;
  updated_at: IsoDate;
}

/**
 * `POST /v1/routines`. A one-off reminder is a `manual` routine with a
 * future `next_trigger_at`; a `cron` routine derives its own slots and must
 * not send one.
 */
export interface RoutineCreateParams {
  name: string;
  trigger_type: RoutineTriggerType;
  description?: string;
  /** Required for `cron`. */
  cron_schedule?: string;
  /** Omit for a prompt routine, which then needs `prompt`. */
  kind?: RoutineKind;
  prompt?: string;
  /** Required unless `kind` is `observation_synthesis`, which must omit it. */
  runtime_group_id?: Uuid;
  /** An existing task each firing posts the prompt into (prompt routines only). */
  task_id?: Uuid;
  /** A one-off slot for a `manual` routine; must be in the future. */
  next_trigger_at?: IsoDate;
  metadata?: RoutineMetadata;
  /** Server default `true`. */
  enabled?: boolean;
  /**
   * At most 20, none with an `id`. Only a prompt routine that starts a task
   * per run takes triggers (no `kind`, no `task_id`).
   */
  triggers?: RoutineTriggerSpec[];
}

/**
 * `PATCH /v1/routines/{id}`. Only the fields set are sent, and an omitted
 * field is left as it is, so nothing can be cleared. `kind` and
 * `trigger_type` are immutable; `metadata` replaces the stored value
 * wholesale.
 */
export interface RoutineUpdateParams {
  name?: string;
  description?: string;
  cron_schedule?: string;
  prompt?: string;
  /** Moves a prompt routine to another runtime group. */
  runtime_group_id?: Uuid;
  task_id?: Uuid;
  /** Schedules, moves or re-arms a `manual` routine's one-off slot; must be in the future. */
  next_trigger_at?: IsoDate;
  metadata?: RoutineMetadata;
  /** `false` pauses and keeps the slot. */
  enabled?: boolean;
  /**
   * Replaces the routine's triggers: an entry with an `id` keeps that
   * trigger with the fields given, one without is new, and every trigger
   * not listed is removed. `[]` removes them all.
   */
  triggers?: RoutineTriggerSpec[];
}

/** Query params for `GET /v1/routines` (`limit` 1–1000, server default 100). */
export interface RoutineListParams extends CursorParams {
  kind?: RoutineKind;
  enabled?: boolean;
  /** `true`: only routines with a next slot; `false`: only those without. */
  scheduled?: boolean;
  /**
   * Only routines that post into this task. Not served until
   * introspection-cloud#3137 ships; a server without it ignores the filter.
   */
  task_id?: Uuid;
}

/**
 * Body of `POST /v1/routines/{id}/trigger`. `parameters` is a JSON object of
 * at most 16 KiB serialized and 8 levels deep (422 past either).
 *
 * A prompt routine that starts a task gets it as `parameters.json` in the
 * task's files, and each `@parameters.<name>` in its prompt becomes that
 * top-level value as JSON (`null`, and listed under the task's
 * `metadata.unresolved_parameters`, when absent). A platform routine reads
 * its kind's own keys and refuses any other (422): `observation_synthesis`
 * takes `conversation_ids` (1–100 conversation ids to synthesize now);
 * `observation_clustering` takes none.
 */
export interface RoutineTriggerParams {
  parameters?: Record<string, unknown> | null;
}

/**
 * Response of `POST /v1/routines/{id}/trigger`. A `skipped` status carries
 * its `reason` and records no event.
 */
export interface RoutineTriggerResponse {
  status: RoutineExecutionStatus;
  routine_id: Uuid;
  /** The task created, or posted into. */
  task_id?: Uuid | null;
  /**
   * The run this trigger started, when it has one, such as the run an
   * `observation_clustering` routine's
   * `introspection.observation_clustering.run` events carry.
   */
  run_id?: Uuid | null;
  reason?: string | null;
  /** What the run reports, by kind; see {@link RoutineTriggerResult}. */
  result?: RoutineTriggerResult | null;
}

/**
 * A manual trigger's kind-specific report. Open: a kind this SDK predates
 * reports its own keys.
 *
 * @openSchema
 */
export interface RoutineTriggerResult {
  /**
   * `observation_synthesis`: conversations sent to the synthesis queue; each
   * later gets an `introspection.observation_synthesis.completed` event.
   */
  enqueued?: number;
  /** `observation_synthesis` with named `conversation_ids`: what was queued. */
  conversations?: EnqueuedConversation[];
  [key: string]: unknown;
}

/** A conversation a synthesis trigger queued, and the end it queued it at. */
export interface EnqueuedConversation {
  conversation_id: string;
  /**
   * Its completion answers this trigger once the event's
   * `conversation_completed_at` is at or after this.
   */
  completed_at: IsoDate;
}
