import type { ResumeEntry } from "@ag-ui/core";

/**
 * Public REST API types for the Introspection DP `/v1` surface.
 *
 * Field names are kept on-the-wire (snake_case) to match the DP
 * Pydantic models verbatim. See cloud `docs/design/sdk-tasks-files.md`.
 */

export type Uuid = string;
export type IsoDate = string;

export interface Paginated<T> {
  records: T[];
  count: number;
  total_count: number | null;
  next: string | null;
}

export interface ListParams {
  limit?: number;
  next?: string;
  include_total?: boolean;
}

/**
 * Response representation for the bounded telemetry list reads
 * (`GET /v1/conversations`, `GET /v1/events`). `"json"` (the default)
 * returns the {@link Paginated} envelope; `"arrow"` negotiates an Apache
 * Arrow IPC stream via the `Accept` header and reconstructs the same
 * {@link Paginated} shape from the response body + pagination headers, so
 * paging is identical across formats. See cloud
 * `docs/design/agent-cli-machine-contract.md`.
 */
export type ReadFormat = "json" | "arrow";

/**
 * Ergonomic ordering + time-window params shared by the Data-Plane list
 * reads. The client serializes these to the wire query args before
 * sending: `order` → `direction`, `start` → `start_date`, `end` →
 * `end_date`, and `lookback` (a relative duration like `"24h"`) →
 * `start_date = now - lookback`.
 *
 * `lookback` is mutually exclusive with `start`/`end`; passing both
 * throws a {@link ValidationError} client-side before any request.
 */
export interface ReadWindowParams {
  /** Sort direction (server default `"desc"`). Maps to `direction`. */
  order?: "asc" | "desc";
  /**
   * Start of the (inclusive) time window as an ISO-8601 datetime. Maps to
   * `start_date`. Mutually exclusive with {@link lookback}.
   */
  start?: IsoDate;
  /**
   * End of the (inclusive) time window as an ISO-8601 datetime. Maps to
   * `end_date`. Mutually exclusive with {@link lookback}.
   */
  end?: IsoDate;
  /**
   * Relative window as a duration string — `"<n><unit>"` where unit is one
   * of `ms`, `s`, `m`, `h`, `d`, `w` (e.g. `"24h"`, `"7d"`, `"500ms"`).
   * Computed client-side into `start_date = now - lookback`. Mutually
   * exclusive with {@link start} / {@link end}.
   */
  lookback?: string;
  /** Response encoding: `"json"` (default) or `"arrow"`. */
  format?: ReadFormat;
}

// --- tasks ---

export type TaskMode =
  | "agent"
  | "introspect"
  | "system_review"
  | "system_instrumentation"
  | "observation_review"
  | "security_review"
  | "repo_index"
  | "system_discovery"
  | "onboarding"
  | "heartbeat";

export type TaskStatus =
  | "pending"
  | "queued"
  | "scheduled"
  | "running"
  | "awaiting_user"
  | "idle"
  | "completed"
  | "failed"
  | "cancelling"
  | "cancelled";

export interface AgentInfo {
  sandbox_status?: string | null;
  session_id?: string | null;
}

export interface Task {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  created_at: IsoDate;
  updated_at: IsoDate;
  title?: string | null;
  display_index?: number | null;
  mode: TaskMode;
  status: TaskStatus;
  member_id?: Uuid | null;
  automation_id?: Uuid | null;
  runtime_id?: Uuid | null;
  is_archived: boolean;
  started_at?: IsoDate | null;
  completed_at?: IsoDate | null;
  last_user_message_at?: IsoDate | null;
  metadata?: Record<string, unknown> | null;
  agent?: AgentInfo | null;
  identity_key?: string | null;
}

export interface TaskCreateParams {
  title?: string;
  prompt?: string;
  mode?: TaskMode;
  system_id?: string;
  repository_id?: Uuid;
  metadata?: Record<string, unknown>;
  /**
   * Override the interactive idle window (seconds) before the sandbox is
   * torn down. `0` tears down as soon as it's provisioned (e.g. an
   * empty-prompt warm/bake run); omit to use the deployment default.
   * Clamped to the task timeout.
   */
  idle_timeout_seconds?: number;
  /**
   * Fork from a shared conversation: the `/v1/shares` grant id for the source
   * conversation. Its presence makes this create a fork — the new task is seeded
   * with that conversation's history, read via the share (the permissions
   * boundary).
   */
  fork_share_id?: Uuid;
}

export interface TaskUpdateParams {
  title?: string;
  is_archived?: boolean;
  metadata?: Record<string, unknown>;
}

export interface TaskListParams extends ListParams {
  statuses?: TaskStatus[];
  modes?: TaskMode[];
  require_automation_id?: boolean;
  /** Privileged credentials only: audit a specific owner identity. */
  identity_key?: string;
}

export interface TaskPrompt {
  text: string;
  images?: string[];
}

export type TaskRunKind = "prompt" | "steer" | "clear";

export interface TaskRunCreateParams {
  prompt?: TaskPrompt;
  message?: string;
  kind?: TaskRunKind;
  metadata?: Record<string, unknown>;
}

export interface TaskRunResumeParams {
  resume: ResumeEntry[];
}

export interface TaskRun {
  id: string;
  task_id: Uuid;
  status: TaskStatus;
  created_at?: IsoDate | null;
  updated_at?: IsoDate | null;
}

export interface TaskCreateResponse {
  task: Task;
  run: TaskRun;
}

export interface TaskRunResponse {
  run: TaskRun;
}

export interface TaskCancelResponse {
  id: string;
}

export interface TaskCancelOptions {
  /** Defaults to abort when omitted. */
  mode?: "abort" | "drain";
  /** Drain only: force teardown after this many seconds. */
  drain_within_seconds?: number;
}

// --- files ---

export type FileType = "upload" | "filesystem" | "other";

export interface File {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  created_at: IsoDate;
  updated_at: IsoDate;
  name: string;
  file_type: FileType;
  storage_path: string;
  mime_type: string;
  metadata?: Record<string, unknown> | null;
  member_id?: Uuid | null;
  size_bytes: number;
  version: number;
  parent_id?: Uuid | null;
  storage_version_id?: string | null;
  identity_key?: string | null;
  task_id?: Uuid | null;
}

export interface FileListParams extends ListParams {
  name?: string;
  file_type?: FileType;
  storage_path?: string;
  /** Accounting view: files stamped with this task. Access rules still apply. */
  task_id?: Uuid;
  /** Privileged credentials only: audit a specific owner identity. */
  identity_key?: string;
}

export interface FileUpdateParams {
  name?: string;
  metadata?: Record<string, unknown>;
}

export interface FileCreateTextParams {
  name: string;
  content: string;
  mime_type?: string;
}

// --- resource shares (/v1/shares) ---

/** Resource families a share grant can target (tasks are not shareable). */
export type ShareResourceType = "file" | "conversation";

/** A read-sharing grant for a file or conversation (`/v1/shares`). */
export interface ResourceShare {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  created_at: IsoDate;
  updated_at: IsoDate;
  resource_type: ShareResourceType;
  resource_id: string;
  /** Member-targeted grant; `null` means a project-wide grant (everyone). */
  granted_member_id?: Uuid | null;
  /** Grantor (always a member) — the revoke gate. */
  created_by_member_id: Uuid;
  /**
   * Fully-qualified canonical GET URL for the shared resource, carrying the
   * `?share_id` capability (e.g. `…/v1/files/{id}?share_id=…`). Always present on
   * `/v1/shares` reads — follow it to read the resource under this grant.
   */
  url: string;
}

/** Omit `granted_member_id` for a project-wide grant; set it to target one member. */
export interface ShareCreateParams {
  resource_type: ShareResourceType;
  resource_id: string;
  /** Target one member; omit for a project-wide grant (everyone in the project). */
  granted_member_id?: Uuid;
}

export interface ShareListParams extends ListParams {
  resource_type?: ShareResourceType;
  resource_id?: string;
  /** Only shares the caller created. */
  created_by_me?: boolean;
  /** Only shares targeting the caller. */
  granted_to_me?: boolean;
}

// --- runtimes / experiments / runner ---

/**
 * How a Runtime acquires LLM provider credentials at session create.
 *
 * - `"managed"` — Introspection-managed keys (default; current behaviour).
 * - `"byok"`    — the project's Endpoint pool. Applicable LLM endpoints
 *                 are materialised into the session. Session create fails
 *                 with `byok_no_endpoints` if no applicable LLM endpoint
 *                 exists in the project.
 */
export type RuntimeLlmMode = "managed" | "byok";

/**
 * How a runtime group resolves which runtime serves a run.
 *
 * - `"sticky"` — a run pins the runtime that was active when it started and
 *   keeps using it for the whole conversation, even after a newer runtime is
 *   promoted. The production default.
 * - `"latest"` — every run (including restarts of an existing task) resolves
 *   the runtime currently active for the environment. The default for
 *   non-production environments.
 *
 * A per-run `resolution_mode` on the run request overrides the group's
 * setting; a yanked runtime is never resolved under either mode.
 */
export type RuntimeResolutionMode = "sticky" | "latest";

export interface Runtime {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  name: string;
  slug: string;
  description?: string | null;
  recipe_id: Uuid;
  is_active: boolean;
  llm_mode: RuntimeLlmMode;
  created_at: IsoDate;
  updated_at: IsoDate;
  /**
   * When set, the runtime has been withdrawn and will never resolve as the
   * active runtime for its environment; in-flight sticky runs keep using it.
   */
  yanked_at?: IsoDate | null;
  yanked_reason?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface RuntimeListParams extends ListParams {
  /** Project slug or id. */
  project?: string;
  /** Runtime slug or id. */
  runtime?: string;
  recipe_id?: Uuid;
  only_active?: boolean;
  /** Restrict to runtimes serving this environment (e.g. `"production"`). */
  environment?: string;
  /** Omit withdrawn runtimes — mirrors the server-side active resolution. */
  exclude_yanked?: boolean;
}

// --- recipes ---

export interface Recipe {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  repository_id: Uuid;
  name: string;
  slug: string;
  git_ref: string;
  git_commit_sha: string;
  sub_path?: string | null;
  description?: string | null;
  created_by_member_id: Uuid;
  created_at: IsoDate;
  updated_at: IsoDate;
}

export interface RecipeCreate {
  project: string;
  repository_id: Uuid;
  name: string;
  git_ref: string;
  git_commit_sha: string;
  sub_path?: string;
  slug?: string;
  description?: string;
}

export interface RecipeUpdate {
  name?: string;
  description?: string;
}

export interface RecipeListParams extends ListParams {
  project?: string;
  repository_id?: Uuid;
  name?: string;
  git_ref?: string;
  git_commit_sha?: string;
}

export type ExperimentStatus = "draft" | "running" | "ended" | "cancelled";

export type ExperimentGoalDirection = "maximize" | "minimize";

/** Canary bound over one goal component's rate. */
export interface ExperimentGoalGuard {
  min?: number | null;
  max?: number | null;
}

/**
 * Judge-backed reward component. `judge_id` comes from `GET /v1/judges` —
 * judges cannot be created via the API; author a `judges/*.yaml` in the
 * recipe repository and it syncs when a runtime versions that commit.
 */
export interface JudgeGoalComponent {
  source: "judge";
  judge_id: Uuid;
  judge_definition_hash?: string | null;
  weight?: number;
  guard?: ExperimentGoalGuard | null;
}

/** Reserved shape for future telemetry-backed reward components. */
export interface TelemetryGoalComponent {
  source: "telemetry";
  column?: string | null;
  aggregation?: string | null;
  weight?: number;
  guard?: ExperimentGoalGuard | null;
}

export type ExperimentGoalComponent =
  JudgeGoalComponent | TelemetryGoalComponent;

/**
 * Composite objective the bandit optimizes. Create requires at least one
 * `source: "judge"` component with positive weight — the v1 scorer only
 * implements judge-backed reward.
 */
export interface ExperimentGoal {
  kind: "composite";
  direction?: ExperimentGoalDirection;
  components: ExperimentGoalComponent[];
}

/** One arm — a runtime version in the experiment's group + display label. */
export interface ExperimentArm {
  runtime_id: Uuid;
  arm_label: string;
  agent_overrides?: Record<string, string> | null;
}

export interface Experiment {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  name: string;
  runtime_group_id?: Uuid | null;
  environment?: string | null;
  status: ExperimentStatus;
  routing_strategy?: string | null;
  arms: ExperimentArm[];
  goal_json?: ExperimentGoal | null;
  scoring_interval_seconds?: number | null;
  hash_key_fields?: string[] | null;
  sample_rate?: number | null;
  description?: string | null;
  posterior_json?: Record<string, unknown> | null;
  weights_json?: Record<string, number> | null;
  started_at?: IsoDate | null;
  ended_at?: IsoDate | null;
  halted_at?: IsoDate | null;
  halted_reason?: string | null;
  created_at: IsoDate;
  updated_at: IsoDate;
}

/**
 * `POST /v1/experiments` body. Creates a draft that routes nothing until
 * `start`. `arms` takes 2–20 runtime versions sharing `runtime_group_id`.
 */
export interface ExperimentCreate {
  project: string;
  name: string;
  runtime_group_id: Uuid;
  arms: ExperimentArm[];
  goal_json: ExperimentGoal;
  description?: string;
  environment?: string;
  scoring_interval_seconds?: number;
  hash_key_fields?: string[];
  sample_rate?: number;
}

/**
 * `PATCH /v1/experiments/{id}`. Status transitions use start/end/cancel;
 * `runtime_group_id` and `arms` are immutable once running.
 */
export interface ExperimentUpdate {
  name?: string;
  description?: string;
  goal_json?: ExperimentGoal;
  scoring_interval_seconds?: number;
  hash_key_fields?: string[];
  sample_rate?: number;
}

export interface ExperimentListParams extends ListParams {
  project?: string;
  name?: string;
  status?: ExperimentStatus;
}

export interface RunnerIdentity {
  user_id: string | null;
  anonymous_id: string | null;
  conversation_id: string | null;
}

export interface RunnerRecipeSummary {
  repository_id: Uuid;
  git_ref: string;
  git_commit_sha: string;
}

export interface RunnerContext {
  runtime_id: Uuid;
  runtime_group_id?: Uuid | null;
  experiment_id: Uuid | null;
  recipe_id: Uuid;
  recipe_repository_id?: Uuid | null;
  recipe_git_ref?: string | null;
  recipe_git_commit_sha?: string | null;
  recipe: RunnerRecipeSummary;
  arm_label: string | null;
  agent_name?: string | null;
  identity: RunnerIdentity;
  /** Echoed from the request when supplied. */
  caller?: RunCaller;
}

/**
 * Routing target for a runner — which DP endpoint / region the
 * session is bound to.
 */
export interface RunnerDeployment {
  /** DP base URL the runner should talk to. */
  endpoint: string;
  /** Short slug identifier for the deployment (e.g. `"gcp01"`). */
  slug: string;
  /** Region the deployment is hosted in (e.g. `"us-east-1"`). */
  region: string;
}

/**
 * CP `/run` response — the customer wire.
 *
 * Sandbox-internal fields (`credentials` for ext_proc egress injection,
 * the `bootstrap` repo manifest, DP `limits`, and the Otari
 * `llm_proxy` descriptor) live on `InternalRunnerSpec` on the CP→DP
 * internal route. They are never returned to customer callers.
 */
export interface RunnerSpec {
  session_id: string;
  /** Routing target — DP endpoint / slug / region. */
  deployment: RunnerDeployment;
  /**
   * RS256 `session_locator` JWT — the only credential the customer
   * holds. Sent as the `Authorization: Bearer ...` value on all DP
   * calls.
   */
  session_token: string;
  /** Session lifetime (ISO-8601). */
  expires_at: IsoDate;
  /** Resolved runtime / arm / recipe / identity / caller context. */
  runtime_context: RunnerContext;
}

export interface RunIdentityInput {
  user_id?: string;
  anonymous_id?: string;
  conversation_id?: string;
}

/**
 * Optional segment.io-style observability payload on a {@link RunRequest}.
 *
 * Used by CP for telemetry / experiment-report slicing only —
 * **routing never reads `caller`**. Arm picks walk `identity.*` via
 * `hash_key_fields` only. Mixing the two would be a privacy +
 * stability footgun (e.g. routing on IP).
 *
 * Unknown fields ride along verbatim via the index signature.
 */
export interface RunCaller {
  ip?: string;
  user_agent?: string;
  locale?: string;
  library?: RunCallerLibrary;
  page?: RunCallerPage;
  /** Pass-through for app / device / os / campaign / network / etc. */
  [key: string]: unknown;
}

export interface RunCallerLibrary {
  name?: string;
  version?: string;
  [key: string]: unknown;
}

export interface RunCallerPage {
  path?: string;
  referrer?: string;
  search?: string;
  title?: string;
  url?: string;
  [key: string]: unknown;
}

/**
 * Input body for the CP `/v1/runtimes/{id}/run` and
 * `/v1/experiments/{id}/run` routes. The URL identifies the
 * runtime/experiment — do NOT include `deployment`, `runtime_id`, or
 * `experiment_id` in the body.
 */
export interface RunRequest {
  identity?: RunIdentityInput;
  /** Optional observability payload — see {@link RunCaller}. */
  caller?: RunCaller;
  /** Optional entrypoint agent. Omit to use the runtime default. */
  agent_name?: string;
  ttl_seconds?: number;
  /** Optional space-separated runner scopes, capped by the Control Plane. */
  scope?: string;
}

// --- events ---

/**
 * The six canonical platform event families served by `GET /v1/events` —
 * a closed, typed set. Legacy stored names (e.g.
 * `introspection.observation.generated`, `introspection.pattern.created`)
 * are normalized server-side to these canonical names; anything outside
 * the set (customer `track()` events, `gen_ai.*`) is not enumerable via
 * `/v1/events` and is reachable through `POST /v1/metrics` only.
 */
export const IntrospectionEventNames = {
  FEEDBACK: "introspection.feedback",
  OBSERVATION: "introspection.observation",
  OBSERVATION_CLUSTERING_RUN: "introspection.observation_clustering.run",
  JUDGEMENT: "introspection.judgement",
  PATTERN: "introspection.pattern",
  PATTERN_ASSIGNMENT: "introspection.pattern.assignment",
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

// --- whole-event members: envelope + typed payload, literal discriminator ---

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

export interface JudgementEvent extends IntrospectionEventEnvelope {
  event_name: typeof IntrospectionEventNames.JUDGEMENT;
  payload: JudgementPayload;
}

/**
 * The discriminated union of the six canonical families. Narrow on the
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
  | ObservationEvent
  | PatternEvent
  | PatternAssignmentEvent
  | ClusteringRunEvent
  | FeedbackEvent
  | JudgementEvent;

/**
 * Structurally-typed fallback for forward compatibility: a row whose
 * `event_name` isn't one of the {@link IntrospectionEventNames} this SDK
 * version knows (e.g. a seventh family added server-side). Such rows are
 * surfaced as-is — never dropped, never a thrown error.
 */
export interface UnknownEvent extends IntrospectionEventEnvelope {
  event_name: string;
  payload?: unknown;
}

/** True when `ev` belongs to one of the six known families. */
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
export interface EventListParams extends ListParams, ReadWindowParams {
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
}

// --- metrics ---

/** Aggregation views selectable in a `POST /v1/metrics` request. */
export type MetricView =
  | "spans"
  | "conversations"
  | "events"
  | "judgements"
  | "observations"
  | "patterns";

/** Aggregation operators. */
export type MetricAggregation =
  | "count"
  | "count_distinct"
  | "sum"
  | "avg"
  | "min"
  | "max"
  | "p50"
  | "p75"
  | "p90"
  | "p95"
  | "p99";

/** Filter operators for a metrics query. */
export type MetricFilterOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "nin"
  | "exists"
  | "contains";

/** Named time-bucket widths. */
export type MetricInterval =
  | "10s"
  | "30s"
  | "1m"
  | "5m"
  | "15m"
  | "30m"
  | "1h"
  | "2h"
  | "3h"
  | "6h"
  | "12h"
  | "1d"
  | "2d"
  | "1w"
  | "1mo";

/** One requested metric: an aggregation over an optional measure field. */
export interface MetricSpec {
  /** Measure field. Omit for `count`; required for every other aggregation. */
  measure?: string | null;
  aggregation: MetricAggregation;
}

/** A group-by dimension. */
export interface MetricDimension {
  field: string;
}

/** A pre-aggregation row filter. */
export interface MetricFilter {
  field: string;
  operator: MetricFilterOperator;
  /** Scalar for comparison ops, list for `in`/`nin`, omitted for `exists`. */
  value?: string | number | boolean | Array<string | number | boolean> | null;
}

/** Time bucketing — supply `granularity` (named/`auto`) or `bins` (count). */
export interface MetricTimeDimension {
  granularity?: MetricInterval | "auto" | null;
  bins?: number | null;
}

/** Ordering term: reference a metric by index, a dimension by field, or time. */
export interface MetricOrderBy {
  type: "metric" | "dimension" | "time";
  direction?: "asc" | "desc";
  metric_index?: number | null;
  field?: string | null;
}

/** Post-aggregation filter on a metric by request index. */
export interface MetricHaving {
  metric_index: number;
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
  value: number;
}

/** Row/series limits for a metrics query. */
export interface MetricQueryConfig {
  row_limit?: number;
  series_limit?: number | null;
}

/**
 * Request body for `POST /v1/metrics` — the bounded, allow-listed
 * telemetry aggregation contract. Unknown fields are rejected server-side.
 * See cloud `docs/design/metrics-api.md`.
 */
export interface MetricQueryRequest {
  view: MetricView;
  metrics: MetricSpec[];
  dimensions?: MetricDimension[];
  filters?: MetricFilter[];
  time_dimension?: MetricTimeDimension | null;
  order_by?: MetricOrderBy[];
  having?: MetricHaving[];
  /** Window start (inclusive), ISO-8601 datetime. */
  from_timestamp: IsoDate;
  /** Window end (exclusive), ISO-8601 datetime. */
  to_timestamp: IsoDate;
  config?: MetricQueryConfig;
}

/** One resolved dimension field/value on a metrics result row. */
export interface MetricDimensionValue {
  field: string;
  value: string;
}

/** One resolved metric value on a metrics result row. */
export interface MetricResultValue {
  metric_index: number;
  measure: string | null;
  aggregation: MetricAggregation;
  value: number;
}

/** A single aggregated row of a metrics result. */
export interface MetricResultRow {
  /** Bucket start (epoch ms) when the query is time-bucketed, else `null`. */
  timestamp?: number | null;
  dimensions: MetricDimensionValue[];
  metrics: MetricResultValue[];
}

/** The time window actually applied to a metrics query. */
export interface MetricEffectiveWindow {
  start: IsoDate;
  end: IsoDate;
}

/** Metadata describing an executed metrics query. */
export interface MetricQueryMeta {
  view: MetricView;
  window: MetricEffectiveWindow;
  row_count: number;
  row_limit: number;
  interval?: MetricInterval | null;
  step_seconds?: number | null;
  /** True when a percentile aggregation used approximate state. */
  approximate: boolean;
  /** True when the result hit the row/series limit. */
  truncated: boolean;
  order_by: MetricOrderBy[];
}

/** Response body for `POST /v1/metrics`. */
export interface MetricQueryResponse {
  data: MetricResultRow[];
  meta: MetricQueryMeta;
}
