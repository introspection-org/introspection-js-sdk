import type { CursorParams, IsoDate, Uuid } from "./common.js";
import type { TaskFileRef, TaskRepoRequest } from "./tasks.js";

/**
 * The firing an `introspection.routines.triggered` / `.skipped` event
 * records: `cron` for a schedule slot, `manual` for anything else.
 * Open-ended.
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

/** A trigger `type` this SDK version models. */
export type KnownRoutineTriggerType =
  "schedule" | "slack" | "github" | "linear" | "webhook";

/** Fires on a 5-field `cron` in `timezone` (IANA, UTC when unset). */
export interface RoutineScheduleTrigger {
  id: Uuid;
  type: "schedule";
  cron: string;
  timezone?: string | null;
}

/** `channel_ids` is required for `slack.message.posted`. */
export interface RoutineSlackTrigger {
  id: Uuid;
  type: "slack";
  event_types: string[];
  channel_ids?: string[];
  emoji?: string[];
}

export interface RoutineGithubTrigger {
  id: Uuid;
  type: "github";
  event_types: string[];
  repository_ids?: string[];
  branches?: string[];
}

/** Scoped to the project's bound Linear teams. */
export interface RoutineLinearTrigger {
  id: Uuid;
  type: "linear";
  event_types: string[];
  to_states?: string[];
}

/**
 * Listens to the project connector `connector_slug`. Its `event_types` are
 * the JSON body's string `type` (else `webhook.received`), or `*` alone.
 * `payload_fields` (at most 20 keys) maps a top-level body key to the values
 * its scalar may hold (a string as given, any other scalar as JSON).
 */
export interface RoutineWebhookTrigger {
  id: Uuid;
  type: "webhook";
  connector_slug: string;
  event_types: string[];
  payload_fields?: Record<string, string[]>;
}

/**
 * A trigger of a `type` this SDK version predates, as the server sent it.
 *
 * @openSchema
 */
export interface RoutineUnknownTrigger {
  id: Uuid;
  type: string;
  [key: string]: unknown;
}

export type KnownRoutineTrigger =
  | RoutineScheduleTrigger
  | RoutineSlackTrigger
  | RoutineGithubTrigger
  | RoutineLinearTrigger
  | RoutineWebhookTrigger;

/**
 * What starts a routine besides `trigger(id)`, discriminated on `type`.
 * Narrow with {@link isKnownRoutineTrigger} before switching on `type`. A
 * response omits a filter key the trigger does not set. Event `event_types`
 * (1–50) are `{provider}.{object}.{action}` names, such as
 * `github.pull_request.opened`; an event run receives the event's body as its
 * parameters (`parameters.json`, and `@parameters.<key>` in the prompt).
 */
export type RoutineTrigger = KnownRoutineTrigger | RoutineUnknownTrigger;

const KNOWN_ROUTINE_TRIGGER_TYPES: readonly string[] = [
  "schedule",
  "slack",
  "github",
  "linear",
  "webhook",
] satisfies KnownRoutineTriggerType[];

/** True when `trigger` is of a `type` this SDK version models. */
export function isKnownRoutineTrigger(
  trigger: RoutineTrigger,
): trigger is KnownRoutineTrigger {
  return KNOWN_ROUTINE_TRIGGER_TYPES.includes(trigger.type);
}

/**
 * One trigger on create or update: an entry with an `id` keeps that existing
 * trigger (its `type` is fixed), one without adds a trigger. An unknown-type
 * trigger read from the routine can be passed back to keep it.
 */
export type RoutineTriggerSpec =
  | (KnownRoutineTrigger extends infer T
      ? T extends KnownRoutineTrigger
        ? Omit<T, "id"> & { id?: Uuid }
        : never
      : never)
  | RoutineUnknownTrigger;

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

/** A condition evaluated before a routine runs. */
export interface RoutineCondition {
  type: RoutineConditionType;
  runtime_group_id?: Uuid | null;
}

/**
 * A routine's typed settings. On update it replaces the stored value
 * wholesale, so send the current values of the fields to keep.
 */
export interface RoutineMetadata {
  /** Repositories a task-backed routine clones. */
  repositories: TaskRepoRequest[];
  conditions: RoutineCondition[];
  /**
   * Only on `observation_synthesis`: the most conversations a batch run
   * samples; null for the server default.
   */
  synthesis_max_conversations?: number | null;
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
  /** `null` for a person's own prompt routine. */
  kind?: RoutineKind | null;
  prompt?: string | null;
  /** Repositories a task-backed routine clones. */
  routine_metadata: RoutineMetadata;
  tags: string[];
  last_triggered_at?: IsoDate | null;
  /**
   * The next slot: the earliest across its `schedule` triggers (read-only
   * then), else a client-set one-off slot, cleared once it fires.
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
 * `POST /v1/routines`. A one-off reminder is a routine with no `schedule`
 * trigger and a future `next_trigger_at`.
 */
export interface RoutineCreateParams {
  name: string;
  description?: string;
  /** Omit for a prompt routine, which then needs `prompt`. */
  kind?: RoutineKind;
  prompt?: string;
  /** Required unless `kind` is `observation_synthesis`, which must omit it. */
  runtime_group_id?: Uuid;
  /** An existing task each firing posts the prompt into (prompt routines only). */
  task_id?: Uuid;
  /** A one-off slot, only without a `schedule` trigger; must be in the future. */
  next_trigger_at?: IsoDate;
  /** `repositories` and `conditions` default to `[]`. */
  routine_metadata?: Partial<RoutineMetadata>;
  /** Server default `true`. */
  enabled?: boolean;
  /**
   * At most 20. Event triggers only on a prompt routine that starts a task
   * per run (no `kind`, no `task_id`); a platform routine takes only
   * `schedule` triggers.
   */
  triggers?: RoutineTriggerSpec[];
}

/**
 * `PATCH /v1/routines/{id}`. Only the fields set are sent, and an omitted
 * field is left as it is, so nothing can be cleared. `kind` is immutable,
 * and `runtime_group_id` moves a prompt routine to another runtime group.
 */
export interface RoutineUpdateParams extends Partial<
  Omit<RoutineCreateParams, "kind" | "triggers">
> {
  /**
   * Replaces the routine's triggers (at most 20): every trigger not listed
   * is removed, and `[]` removes them all.
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
 * Body of `POST /v1/routines/{id}/trigger`, as sent on the wire. `parameters`
 * is a JSON object of at most 16 KiB serialized and 8 levels deep (422 past
 * either).
 *
 * A prompt routine that starts a task reads its parameters from the
 * `parameters.json` among `files`, and each `@parameters.<name>` in its prompt
 * becomes that top-level value as JSON (`null`, and listed under the task's
 * `metadata.unresolved_parameters`, when absent). Inline `parameters` win over
 * the file; without them the server reads the file (a JSON object of at most
 * 256 KiB). A platform routine reads its kind's own keys from `parameters`
 * and refuses any other (422): `observation_synthesis` takes
 * `conversation_ids` (1–100 conversation ids to synthesize now);
 * `observation_clustering` takes none.
 */
export interface RoutineTriggerBody {
  parameters?: Record<string, unknown>;
  /**
   * Files API references attached to the run's new task (at most 100). Only
   * a prompt routine that starts a task per run takes files (422 for a
   * platform routine or one that posts into an existing task).
   */
  files?: TaskFileRef[];
}

/**
 * Options of `routines.trigger(id, params)`.
 *
 * - `parameters` as an object: sent inline. For a routine that starts its
 *   own task they are also uploaded first through the Files API as
 *   `routine-parameters/<uuid>.json` (a 30-day TTL) and attached to the
 *   run's task as `parameters.json`; a platform routine or one that posts
 *   into an existing task takes no files, so gets only the inline value.
 *   `attachParametersFile` unset reads the routine to decide (one extra
 *   `GET`); `true` or `false` skips the read and forces the choice.
 * - `parameters` as a string: the id of an uploaded Files API file (a JSON
 *   object of at most 256 KiB) the server reads, attached as
 *   `parameters.json`; no read, no upload. Any other string is a
 *   `TypeError`, thrown before a request.
 * - `files`: more Files API references for the run's task, passed through.
 */
export interface RoutineTriggerParams {
  parameters?: Record<string, unknown> | Uuid;
  files?: TaskFileRef[];
  /** Unset: decide from the routine; see {@link RoutineTriggerParams}. */
  attachParametersFile?: boolean;
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
