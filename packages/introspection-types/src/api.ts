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

export interface RuntimeCreate {
  /** Project slug or id. */
  project: string;
  name: string;
  slug?: string;
  recipe_id: Uuid;
  description?: string;
  metadata?: Record<string, unknown>;
  is_active?: boolean;
  /** Defaults to `"managed"` on the server when omitted. */
  llm_mode?: RuntimeLlmMode;
}

export interface RuntimeUpdate {
  name?: string;
  description?: string;
  recipe_id?: Uuid;
  is_active?: boolean;
  metadata?: Record<string, unknown>;
  llm_mode?: RuntimeLlmMode;
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

export type ExperimentStatus = "draft" | "running" | "concluded" | "cancelled";

export interface Arm {
  label: string;
  recipe_id: Uuid;
  weight?: number;
}

export interface Experiment {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  name: string;
  description?: string | null;
  status: ExperimentStatus;
  arms: Arm[];
  control_arm_label?: string | null;
  winner_arm_label?: string | null;
  created_at: IsoDate;
  updated_at: IsoDate;
  started_at?: IsoDate | null;
  concluded_at?: IsoDate | null;
  metadata?: Record<string, unknown> | null;
}

export interface ExperimentCreate {
  project: string;
  name: string;
  description?: string;
  arms: Arm[];
  control_arm_label?: string;
  metadata?: Record<string, unknown>;
}

export interface ExperimentUpdate {
  name?: string;
  description?: string;
  arms?: Arm[];
  control_arm_label?: string;
  metadata?: Record<string, unknown>;
}

export interface ExperimentListParams extends ListParams {
  project?: string;
  name?: string;
  status?: ExperimentStatus;
}

export interface ExperimentEndParams {
  winner_arm_label?: string;
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
  experiment_id: Uuid | null;
  recipe_id: Uuid;
  recipe: RunnerRecipeSummary;
  arm_label: string | null;
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
  ttl_seconds?: number;
  /**
   * Pin to a specific recipe. When supplied, CP resolves the runtime
   * row in the targeted name whose `recipe_id` matches this value
   * server-side. Populated by {@link RuntimeHandle.pin}.
   */
  recipe_id?: Uuid;
}

// --- events ---

/** Readable projections exposed through `GET /v1/events`. */
export type EventGrain =
  "raw" | "introspection.observation" | "introspection.pattern";

/** Optional raw-event expansions (repeated `include` param). */
export type EventInclude = "attributes" | "body";

/** Allow-listed fields for event ordering. */
export type EventSortField = "created";

/**
 * One raw event record from `otel_logs`, returned by `GET /v1/events`
 * (default / `grain=raw`) inside the standard cursor envelope
 * `Paginated<RawEvent>`.
 */
export interface RawEvent {
  /** Event ID (`LogAttributes.event.id`). */
  id: string;
  /** Event timestamp. */
  timestamp: IsoDate;
  /** Trace ID (hex string). */
  trace_id?: string | null;
  /** Span ID (hex string). */
  span_id?: string | null;
  /** GenAI conversation ID. */
  conversation_id?: string | null;
  /** Resolved event name. */
  event_name?: string | null;
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
  /** Log body text (only when `include=body`). */
  body?: string | null;
  /** Raw log attributes (only when `include=attributes`). */
  attributes?: Record<string, unknown> | null;
}

/**
 * Query params for `GET /v1/events` (cursor paging — `limit` / `next`
 * come from {@link ListParams}; ordering + window come from
 * {@link ReadWindowParams}). All filters are optional and combined with
 * AND logic; date-range filters are inclusive.
 */
export interface EventListParams extends ListParams, ReadWindowParams {
  /** Event grain projection (server default `"raw"`). */
  grain?: EventGrain;
  /** Event field to order by (server default `"created"`). */
  sort?: EventSortField;
  /** Sort direction (server default `"desc"`). Prefer `order` from {@link ReadWindowParams}. */
  direction?: "asc" | "desc";
  /** Lower bound (inclusive) on timestamp. Prefer `start` / `lookback`. */
  start_date?: IsoDate;
  /** Upper bound (inclusive) on timestamp. Prefer `end`. */
  end_date?: IsoDate;
  /** Filter by conversation ID. */
  conversation_id?: string;
  /** Filter observations by conversation IDs (repeated param). */
  conversation_ids?: string[];
  /** Filter by service name. */
  service_name?: string;
  /** Filter by environment lane. */
  environment?: string;
  /** Filter by runtime group ID. */
  runtime_group_id?: Uuid;
  /** Filter observations with no runtime group. */
  runtime_group_unattributed?: boolean;
  /** Observation/pattern lens filter. */
  lens?: string;
  /** Observation pattern assignment filter. */
  pattern_id?: Uuid;
  /** Pattern status filter. */
  status?: string;
  /** Include superseded observations. */
  include_superseded?: boolean;
  /** Observation severity filters (repeated param). */
  severities?: string[];
  /** Filter by exact event name. */
  event_name?: string;
  /** Filter by event name prefix. */
  event_name_prefix?: string;
  /** Filter by trace ID. */
  trace_id?: string;
  /** Filter by span ID. */
  span_id?: string;
  /** Filter by event IDs (repeated param, max 500). */
  event_id?: string[];
  /** Full-text search over the event body. */
  q?: string;
  /** RE2 regex search over the event body. */
  q_regex?: string;
  /** Optional expansions: `attributes`, `body` (repeated param). */
  include?: EventInclude[];
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
