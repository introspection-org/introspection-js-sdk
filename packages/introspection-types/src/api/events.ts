import type {
  AutomationSkipReason,
  AutomationTriggerType,
} from "./automations.js";
import type {
  CursorParams,
  IsoDate,
  ReadWindowParams,
  Uuid,
} from "./common.js";

/**
 * The canonical platform event families served by `GET /v1/events` —
 * a closed, typed set. Legacy stored names (e.g.
 * `introspection.observation.generated`, `introspection.pattern.created`)
 * are normalized server-side to these canonical names; anything outside
 * the set (customer `track()` events, `gen_ai.*`) is not enumerable via
 * `/v1/events` and is reachable through `POST /v1/metrics` only.
 */
export const IntrospectionEventNames = {
  ANNOTATION: "introspection.annotation",
  FEEDBACK: "introspection.feedback",
  OBSERVATION: "introspection.observation",
  OBSERVATION_CLUSTERING_RUN: "introspection.observation_clustering.run",
  JUDGEMENT: "introspection.judgement",
  PATTERN: "introspection.pattern",
  PATTERN_ASSIGNMENT: "introspection.pattern.assignment",
  AUTOMATION_TRIGGERED: "introspection.automation.triggered",
  /** Project-owned: readable only with project-wide telemetry access. */
  AUTOMATION_SKIPPED: "introspection.automation.skipped",
} as const;

/** Union of the canonical family names in {@link IntrospectionEventNames}. */
export type IntrospectionEventName =
  (typeof IntrospectionEventNames)[keyof typeof IntrospectionEventNames];

/**
 * Common event envelope — the queryable surface shared by every family.
 * `org_id` / `project_id` are never serialized: tenant scope is implied
 * by the bearer token. The `event_name` discriminator lives here at the
 * top level; each family member narrows it to its literal.
 */
export interface IntrospectionEventEnvelope {
  /** Event ID (globally unique). */
  id: string;
  /**
   * Envelope timestamp. Per-family semantics: `observed_at` for
   * observations (fold), `updated_at` for patterns (catalog cursor),
   * emit/observed time for the stream families.
   */
  timestamp: IsoDate;
  /** Canonical family name — the union discriminator. */
  event_name: string;
  /** Trace ID (hex string). */
  trace_id?: string | null;
  /** Span ID (hex string). */
  span_id?: string | null;
  /** GenAI conversation ID. */
  conversation_id?: string | null;
  /** OTel service name. */
  service_name?: string | null;
  /** Environment lane. */
  environment?: string | null;
  /** Resolved runtime group ID. */
  runtime_group_id?: Uuid | null;
  /** Resolved runtime ID. */
  runtime_id?: Uuid | null;
  /** Resolved experiment ID. */
  experiment_id?: Uuid | null;
  /** Recipe git commit SHA. */
  recipe_git_commit_sha?: string | null;
}

/**
 * One resolved observation — the server-side fold: supersession applied
 * and the CURRENT pattern assignment joined from later assignment events.
 */
export interface ObservationPayload {
  observation_id: Uuid;
  lens: string;
  label?: string | null;
  summary?: string | null;
  severity?: string | null;
  confidence?: number | null;
  segment?: number | null;
  sentiment?: string | null;
  resolution?: string | null;
  evidence_refs?: string[] | null;
  prompt_version?: string | null;
  model?: string | null;
  source_hash?: string | null;
  replaces_observation_id?: Uuid | null;
  /** CURRENT pattern assignment (fold). */
  pattern_id?: string | null;
  /** Score of the current assignment (fold). */
  assignment_score?: number | null;
  /** Method of the current assignment (fold). */
  assignment_method?: string | null;
  metadata?: Record<string, unknown> | null;
}

// jscpd:ignore-start -- interface field list mirroring the wire schema
/**
 * One folded pattern catalog row — the pattern *as it currently is*
 * (latest lifecycle action + fold timestamps).
 */
export interface PatternPayload {
  pattern_id: string;
  /** Latest lifecycle action (`created` | `updated` | `retired`). */
  action?: string | null;
  name?: string | null;
  description?: string | null;
  lens?: string | null;
  /** Current status (fold): `active` | `retired`. */
  status?: string | null;
  /** Fold timestamps. */
  created_at?: IsoDate | null;
  updated_at?: IsoDate | null;
  retired_at?: IsoDate | null;
  last_detected_at?: IsoDate | null;
  reason?: string | null;
  replacement_pattern_id?: string | null;
  derived_from_pattern_id?: string | null;
  run_id?: string | null;
}
// jscpd:ignore-end

/** One observation → pattern assignment event. */
export interface PatternAssignmentPayload {
  /** Identity — the observation the (un)assignment applies to. */
  observation_id: Uuid;
  /** Assigned pattern; `null` = explicitly unassigned. */
  pattern_id?: string | null;
  method?: string | null;
  run_id?: string | null;
  score?: number | null;
}

/** One clustering run over observations. */
export interface ClusteringRunPayload {
  run_id: string;
  lens?: string | null;
  status?: string | null;
  trigger?: string | null;
  observation_count?: number | null;
  pattern_count?: number | null;
  noise_count?: number | null;
  params?: Record<string, unknown> | null;
  replaces_run_id?: string | null;
  error?: string | null;
}

/**
 * One feedback event, mirroring the SDK `feedback()` emitters:
 * `properties.name` / `properties.comments` / `properties.value` plus the
 * `identity.*` attributes. `sentiment` is an optional EMITTED field —
 * never derived server-side.
 */
export interface FeedbackPayload {
  /** The feedback label (`"thumbs_up"`, …). */
  name: string;
  comments?: string | null;
  /** Numeric axis, when present. */
  value?: number | null;
  user_id?: string | null;
  anonymous_id?: string | null;
  /** `positive` | `negative` | `neutral`, when emitted. */
  sentiment?: string | null;
  /** Response the feedback anchors to (`gen_ai.request.previous_response_id`). */
  previous_response_id?: string | null;
  /** Emitting agent name (`gen_ai.agent.name`). */
  agent_name?: string | null;
  /** Emitting agent ID (`gen_ai.agent.id`). */
  agent_id?: string | null;
  /** Remaining `properties.*` extras. */
  properties?: Record<string, unknown> | null;
}

/** One member-authored annotation mutation. */
export interface AnnotationPayload {
  member_id: Uuid;
  /** Complete label snapshot when this event changes labels. */
  labels?: string[] | null;
  /** Immutable qualitative comment when this event adds one. */
  comment?: string | null;
  /** Complete reviewer snapshot when this event changes assignments. */
  assignee_member_ids?: Uuid[] | null;
}

/** One judgement, mirroring the runtime-agent judges emitter. */
export interface JudgementPayload {
  judgement_id: string;
  judge_id?: string | null;
  result?: string | null;
  definition_hash?: string | null;
  contract_version?: string | null;
  sequence_hash?: string | null;
  experiment_arm_id?: Uuid | null;
}

/** One automation trigger that ran (`introspection.automation.triggered`). */
export interface AutomationTriggeredPayload {
  automation_id: Uuid;
  automation_name: string;
  prompt?: string | null;
  trigger_type: AutomationTriggerType;
  /** The `next_trigger_at` a scheduled trigger claimed; null for a hand trigger. */
  slot?: IsoDate | null;
  /** The task created, or posted into when `posted` is true. */
  task_id: Uuid;
  posted: boolean;
  /** The task's member, who owns the event. */
  member_id: Uuid;
  runtime_group_id?: Uuid | null;
  /** The person who triggered it by hand. */
  triggered_by_member_id?: Uuid | null;
}

/**
 * One scheduled automation trigger that ran nothing
 * (`introspection.automation.skipped`). Project-owned, so it carries no
 * member. A hand trigger answers its skip to the caller instead.
 */
export interface AutomationSkippedPayload {
  automation_id: Uuid;
  trigger_type: AutomationTriggerType;
  slot?: IsoDate | null;
  /** Set only when the automation targets an existing task. */
  task_id?: Uuid | null;
  reason: AutomationSkipReason;
}

// --- whole-event members: envelope + typed payload, literal discriminator ---

// jscpd:ignore-start -- one envelope interface per event family
export interface ObservationEvent extends IntrospectionEventEnvelope {
  event_name: typeof IntrospectionEventNames.OBSERVATION;
  payload: ObservationPayload;
}

export interface PatternEvent extends IntrospectionEventEnvelope {
  event_name: typeof IntrospectionEventNames.PATTERN;
  payload: PatternPayload;
}

export interface PatternAssignmentEvent extends IntrospectionEventEnvelope {
  event_name: typeof IntrospectionEventNames.PATTERN_ASSIGNMENT;
  payload: PatternAssignmentPayload;
}

export interface ClusteringRunEvent extends IntrospectionEventEnvelope {
  event_name: typeof IntrospectionEventNames.OBSERVATION_CLUSTERING_RUN;
  payload: ClusteringRunPayload;
}

export interface FeedbackEvent extends IntrospectionEventEnvelope {
  event_name: typeof IntrospectionEventNames.FEEDBACK;
  payload: FeedbackPayload;
}

export interface AnnotationEvent extends IntrospectionEventEnvelope {
  event_name: typeof IntrospectionEventNames.ANNOTATION;
  payload: AnnotationPayload;
}

export interface JudgementEvent extends IntrospectionEventEnvelope {
  event_name: typeof IntrospectionEventNames.JUDGEMENT;
  payload: JudgementPayload;
}

export interface AutomationTriggeredEvent extends IntrospectionEventEnvelope {
  event_name: typeof IntrospectionEventNames.AUTOMATION_TRIGGERED;
  payload: AutomationTriggeredPayload;
}

export interface AutomationSkippedEvent extends IntrospectionEventEnvelope {
  event_name: typeof IntrospectionEventNames.AUTOMATION_SKIPPED;
  payload: AutomationSkippedPayload;
}
// jscpd:ignore-end

/**
 * The discriminated union of the canonical families. Narrow on the
 * top-level `event_name`:
 *
 * ```ts
 * if (ev.event_name === "introspection.feedback") ev.payload.name;
 * ```
 *
 * The union is deliberately closed so TypeScript discriminant narrowing
 * works (a `string`-discriminant tail member would disable narrowing for
 * every member). Rows from a family this SDK version doesn't know surface
 * as {@link UnknownEvent} instead — see {@link EventForName}.
 */
export type Event =
  | AnnotationEvent
  | ObservationEvent
  | PatternEvent
  | PatternAssignmentEvent
  | ClusteringRunEvent
  | FeedbackEvent
  | JudgementEvent
  | AutomationTriggeredEvent
  | AutomationSkippedEvent;

/**
 * Structurally-typed fallback for forward compatibility: a row whose
 * `event_name` isn't one of the {@link IntrospectionEventNames} this SDK
 * version knows (e.g. a family added server-side later). Such rows are
 * surfaced as-is — never dropped, never a thrown error.
 */
export interface UnknownEvent extends IntrospectionEventEnvelope {
  event_name: string;
  payload?: unknown;
}

/** True when `ev` belongs to one of the known families. */
export function isKnownEvent(ev: {
  event_name: string;
}): ev is Event & { event_name: IntrospectionEventName } {
  return (Object.values(IntrospectionEventNames) as string[]).includes(
    ev.event_name,
  );
}

/**
 * Maps a requested `event_name` to its typed union member. Unknown names
 * fall back to {@link UnknownEvent}; a non-literal `string` yields the
 * whole {@link Event} union.
 */
export type EventForName<N extends string> = [
  Extract<Event, { event_name: N }>,
] extends [never]
  ? UnknownEvent
  : Extract<Event, { event_name: N }>;

/**
 * Allow-listed fields for event ordering — per-family: observation sorts
 * by `observed_at` (default); pattern by `updated_at` (default),
 * `created_at`, or `last_detected_at`; the stream families by
 * `timestamp` (default).
 */
export type EventSortField =
  | "timestamp"
  | "observed_at"
  | "created_at"
  | "updated_at"
  | "last_detected_at";

/**
 * Query params for `GET /v1/events` (cursor paging — `limit` / `next`
 * come from {@link ListParams}; ordering + window come from
 * {@link ReadWindowParams}).
 *
 * `event_name` is REQUIRED and names exactly one family, so every
 * response page is homogeneous. Envelope filters apply to all families;
 * the family-scoped filters are validated server-side against an
 * allow-map keyed by the requested family (an out-of-family filter is a
 * 422 naming the family). All filters are combined with AND logic;
 * date-range filters are inclusive.
 */
export interface EventListParams extends CursorParams, ReadWindowParams {
  /**
   * The family to list — required, exactly one. Unknown strings are
   * allowed for forward compatibility and type the rows as
   * {@link UnknownEvent}.
   */
  event_name: IntrospectionEventName | (string & Record<never, never>);
  /** Event field to order by (per-family default — see {@link EventSortField}). */
  sort?: EventSortField;
  /** Sort direction (server default `"desc"`). Prefer `order` from {@link ReadWindowParams}. */
  direction?: "asc" | "desc";
  /** Lower bound (inclusive) on timestamp. Prefer `start` / `lookback`. */
  start_date?: IsoDate;
  /** Upper bound (inclusive) on timestamp. Prefer `end`. */
  end_date?: IsoDate;
  /** Filter by conversation ID. */
  conversation_id?: string;
  /** Filter by service name. */
  service_name?: string;
  /** Filter by environment lane. */
  environment?: string;
  /** Filter by runtime group ID. */
  runtime_group_id?: Uuid;
  /** Filter by trace ID. */
  trace_id?: string;
  /** Filter by span ID. */
  span_id?: string;
  owner_key?: string;
  /** Filter by event IDs (repeated param, max 500). */
  event_id?: string[];
  // --- family-scoped filters (server-validated allow-map, one family each) ---
  /** observation: filter by conversation IDs (repeated param, max 500). */
  conversation_ids?: string[];
  /** observation / pattern: lens filter. */
  lens?: string;
  /** observation: current pattern assignment filter. */
  pattern_id?: string;
  /** observation: include superseded versions (default: resolved state only). */
  include_superseded?: boolean;
  /** observation: severity filters (repeated param). */
  severities?: string[];
  /** observation: only rows with no runtime group. */
  runtime_group_unattributed?: boolean;
  /** pattern: status filter (`active` | `retired`). */
  status?: string;
  /** automation triggered / skipped: filter by automation ID. */
  automation_id?: Uuid;
  /** automation triggered / skipped: filter by the task created or posted into. */
  task_id?: Uuid;
}
