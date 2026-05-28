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
}

export interface TaskCreateParams {
  title?: string;
  prompt?: string;
  mode?: TaskMode;
  system_id?: string;
  repository_id?: string;
  metadata?: Record<string, unknown>;
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
}

export interface TaskPrompt {
  text: string;
  images?: string[];
}

export interface TaskRunCreateParams {
  prompt?: TaskPrompt;
  message?: string;
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
}

export interface FileListParams extends ListParams {
  name?: string;
  file_type?: FileType;
  storage_path?: string;
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

export interface Runtime {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  name: string;
  description?: string | null;
  recipe_id: Uuid;
  is_active: boolean;
  llm_mode: RuntimeLlmMode;
  created_at: IsoDate;
  updated_at: IsoDate;
  metadata?: Record<string, unknown> | null;
}

export interface RuntimeCreate {
  project_id: Uuid;
  name: string;
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
  project_id: Uuid;
  name?: string;
  recipe_id?: Uuid;
  only_active?: boolean;
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
  project_id: Uuid;
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
  project_id: Uuid;
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
  project_id: Uuid;
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
  project_id: Uuid;
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
 * the `bootstrap` repo manifest, DP `limits`, and the any-llm
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

// --- SSE ---

export interface SseEvent {
  event: string;
  data: string;
  id?: string;
  retry?: number;
}
