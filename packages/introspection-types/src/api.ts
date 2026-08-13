import type { ResumeEntry } from "@ag-ui/core";

/**
 * Public REST API types for the Introspection DP `/v1` surface.
 *
 * Field names are kept on-the-wire (snake_case) to match the server
 * models verbatim.
 */

export type Uuid = string;
export type IsoDate = string;

/**
 * Environment lane a credential, application, or session belongs to.
 *
 * Assigned server-side — an access token carries it as an `environment` claim,
 * which the DP reads when it establishes a browser session. A client never
 * chooses its own lane.
 */
export type Environment = "development" | "staging" | "production";

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
 * Cursor paging without `include_total`, for the routes that do not compute
 * one. Counting the full match set is not free on the append-only telemetry
 * stores, so `/v1/shares` and `/v1/events` deliberately do not offer it —
 * inheriting the flag there would type a filter that silently does nothing.
 */
export interface CursorParams {
  limit?: number;
  next?: string;
}

/**
 * Response representation for the bounded telemetry list reads
 * (`GET /v1/conversations`, `GET /v1/events`). `"json"` (the default)
 * returns the {@link Paginated} envelope; `"arrow"` negotiates an Apache
 * Arrow IPC stream via the `Accept` header and reconstructs the same
 * {@link Paginated} shape from the response body + pagination headers, so
 * paging is identical across formats.
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

/**
 * The execution shape of a task.
 *
 * `agent` boots the runtime-agent image and runs an interactive LLM agent;
 * `process` runs a one-shot baked script and reports through the same
 * completion path. This replaced the retired `TaskMode`: there are no task
 * modes any more — every agent task is a conversation, and the recipe agent is
 * selected by `agent_name`.
 */
export type TaskKind = "agent" | "process";

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
  kind: TaskKind;
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
  /** `key:value` grouping tags stamped on this task. */
  tags?: string[];
}

/**
 * A reference to an already-uploaded file, attached to a task.
 *
 * Bytes go through `POST /v1/files` first (`files.upload` / `files.createText`);
 * a task only ever carries the reference. `name` is the workspace-relative path
 * the file is mounted as, so it must be relative and must not traverse outside
 * the task's files directory.
 */
export interface TaskFileRef {
  /** Files API file id. */
  id: Uuid;
  /**
   * Workspace-relative path to mount the file at (e.g. `spec.md`,
   * `specs/senior-jd.pdf`).
   *
   * Optional — omit it and the file is mounted under its own name. Supply it
   * only to override: rename, or nest it in a subdirectory. Must be relative
   * and must not traverse outside the task's files directory.
   */
  name?: string;
  size_bytes?: number;
}

/**
 * One `repositories[]` entry: a repository plus the state to clone it at.
 *
 * The recipe's `runtime.github.repositories` grant decides what a runtime MAY
 * clone; this decides what a task DOES clone, and at what ref. An entry
 * outside the grant is dropped by the server, never a launch failure.
 */
export interface TaskRepoRequest {
  /** Registered repository slug, `owner/name`. */
  repo: string;
  /**
   * Branch, tag, or full 40-character commit sha to check out.
   *
   * Omit it and the clone takes the repository's default branch — git resolves
   * the remote's HEAD, so nothing is stored or has to be kept in sync. An
   * abbreviated sha is read as a branch name, so the clone fails and the
   * repository is dropped.
   */
  ref?: string;
  /** Shallow-clone depth; `0` clones full history. Omit for the default. */
  depth?: number;
}

export interface TaskCreateParams {
  title?: string;
  prompt?: string;
  /** Recipe agent to run; omit for the recipe default (`agents/agent.yaml`). */
  agent_name?: string;
  /**
   * Workspace repositories to clone into the sandbox's `workspace/repos/`
   * before the first turn. No count limit — the server refuses a statically
   * wrong list (duplicate slugs, folder collisions), not a long one.
   */
  repositories?: TaskRepoRequest[];
  metadata?: Record<string, unknown>;
  /**
   * Files to attach to this task, by id. Materialized into the agent's
   * workspace and announced to it before the first turn runs.
   *
   * Equivalent to setting `metadata.conversation_files.uploads`, which stays
   * supported; prefer this field.
   */
  files?: TaskFileRef[];
  /**
   * Override the interactive idle window (seconds) before the sandbox is
   * torn down. `0` tears down as soon as it's provisioned (e.g. an
   * empty-prompt warm/bake run); omit to use the deployment default.
   * Clamped to the task timeout.
   */
  idle_timeout_seconds?: number;
  /**
   * Grouping tags stamped on the task at create time (e.g.
   * `customer:acme`). A tag is an opaque, exact, case-sensitive string:
   * `key:value` is a convention, not a grammar. Each tag is 1–128 characters
   * with no whitespace or control characters; at most 64 tags. Duplicates
   * collapse.
   *
   * Filter with {@link TaskListParams.tag}. Tags are also access-bearing: a
   * caller whose member tags intersect a row's tags can read and write it, so
   * a tag shared with a member cohort hands them the task. Shared writers may
   * not replace the tags themselves; that remains owner/privileged-only.
   */
  tags?: string[];
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
  /**
   * Replaces the tag list wholesale (unlike `metadata`, which is merged).
   * Omit to leave tags untouched; pass `[]` to clear them.
   */
  tags?: string[];
}

export interface TaskListParams extends ListParams {
  statuses?: TaskStatus[];
  require_automation_id?: boolean;
  /** Filter by one `key:value` tag. ANDed with the ownership predicate, so it only narrows. */
  tag?: string;
  /** Privileged credentials only: audit a specific owner identity. */
  identity_key?: string;
}

export interface TaskPrompt {
  text: string;
  images?: string[];
}

export type TaskRunKind = "prompt" | "steer";

export interface TaskRunCreateParams {
  prompt?: TaskPrompt;
  kind?: TaskRunKind;
  metadata?: Record<string, unknown>;
  /**
   * Files to attach to this turn — the way to add a file mid-conversation.
   *
   * The agent's workspace is built once when its sandbox starts, so a file
   * attached on a later turn is materialized into the running sandbox before
   * that turn executes, and joins the task's set so a restart replays it.
   * Re-sending a file the task already carries is a no-op.
   *
   * Not accepted alongside `resume`.
   */
  files?: TaskFileRef[];
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
  /**
   * Grouping tags stamped on this file. Tags belong to the file rather than
   * to a version, so they carry forward when a new version is written.
   */
  tags?: string[];
}

export interface FileListParams extends ListParams {
  name?: string;
  file_type?: FileType;
  storage_path?: string;
  /** Accounting view: files stamped with this task. Access rules still apply. */
  task_id?: Uuid;
  /**
   * Privileged credentials only: audit a specific owner. Replaced
   * `identity_key`, which the route stopped accepting when file ownership
   * converged onto member ids — and which FastAPI would have dropped as an
   * unknown query param, serving the caller every file in the project.
   */
  member_id?: Uuid;
  /** Filter by one tag. ANDed with the ownership predicate, so it only narrows. */
  tag?: string;
}

export interface FileUpdateParams {
  name?: string;
  metadata?: Record<string, unknown>;
  /**
   * Replaces the tag list wholesale (unlike `metadata`, which is merged).
   * Omit to leave tags untouched; pass `[]` to clear them.
   *
   * A tag is an opaque, exact, case-sensitive string: `key:value` is a
   * convention, not a grammar. Each tag is 1–128 characters with no
   * whitespace or control characters; at most 64 tags. Duplicates collapse.
   *
   * Tags are access-bearing: a caller whose member tags intersect a file's
   * tags can read and write it, so a tag shared with a member cohort hands
   * them the file. Shared writers may not replace the tags themselves; that
   * remains owner/privileged-only.
   */
  tags?: string[];
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
  /**
   * Identity-targeted grant — an asserted end-user identity rather than a
   * member. Mutually exclusive with `granted_member_id`; both null means a
   * project-wide grant.
   */
  granted_identity_key?: string | null;
  /** Grantor (always a member) — the revoke gate. */
  created_by_member_id: Uuid;
  /** Grantor's coalesced identity, when the creator asserted one. */
  created_by_identity_key?: string | null;
  /**
   * Fully-qualified canonical GET URL for the shared resource, carrying the
   * `?share_id` capability (e.g. `…/v1/files/{id}?share_id=…`). Always present on
   * `/v1/shares` reads — follow it to read the resource under this grant.
   */
  url: string;
}

/**
 * Set exactly one of `granted_member_id` / `granted_identity_key` to target a
 * recipient, or omit both for a project-wide grant. The two are mutually
 * exclusive; supplying both is rejected.
 */
export interface ShareCreateParams {
  resource_type: ShareResourceType;
  resource_id: string;
  /** Target one member. */
  granted_member_id?: Uuid;
  /** Target one asserted end-user identity. */
  granted_identity_key?: string;
}

export interface ShareListParams extends CursorParams {
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
  /**
   * Per-environment git ref each lane tracks
   * ({ environment: "main" | "pr/N" | <sha> }); a tracked lane auto-advances
   * to the newest build from that ref, an absent key is untracked.
   */
  environment_ref?: Record<string, string> | null;
  metadata?: Record<string, unknown> | null;
}

export interface RuntimeListParams extends CursorParams {
  /** Project slug or id. */
  project?: string;
  /** Runtime slug or id. */
  runtime?: string;
  recipe_id?: Uuid;
  /**
   * Restrict to runtimes serving this environment (e.g. `"production"`).
   * An API key already selects its environment, so passing this alongside
   * one is a 400.
   */
  environment?: string;
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

export interface RecipeListParams extends CursorParams {
  project?: string;
  repository_id?: Uuid;
  name?: string;
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

export interface ExperimentListParams extends CursorParams {
  project?: string;
  /** Runtime slug or group id. */
  runtime?: string;
  /** Lane the experiment runs in. */
  environment?: Environment;
  status?: ExperimentStatus;
}

export interface RunnerIdentity {
  user_id: string | null;
  anonymous_id: string | null;
  conversation_id: string | null;
  /** Member tags asserted on the request; see {@link RunIdentityInput.tags}. */
  tags?: string[] | null;
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
 * The fields it omits are server-internal and are never returned to
 * customer callers.
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
  /**
   * Tags to stamp on the `customer` member this identity mints, **if that
   * member is new**. Access-bearing, and bounded on both sides: attenuated to
   * the asserting agent member's own tags, and applied on create only — an
   * existing member's tags are never changed here. Tags use the same opaque,
   * exact-match validation as every other tag write.
   */
  tags?: string[];
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

// --- connectors ---

/**
 * How a connector authenticates against its provider.
 *
 * - `"static"`             — a caller-supplied long-lived token.
 * - `"oauth_stored"`       — OAuth tokens stored server-side after consent.
 * - `"identity_assertion"` — per-call signed identity assertions.
 * - `"federated_exchange"` — federated token exchange.
 * - `"person_authorized"`  — per-action human-in-the-loop approval.
 */
export type ConnectorAuthMode =
  | "static"
  | "oauth_stored"
  | "identity_assertion"
  | "federated_exchange"
  | "person_authorized";

export type ConnectorStatus = "pending" | "active" | "error";

export type ConnectionStatus =
  "pending_authorization" | "active" | "refresh_failed" | "revoked";

/** Who a connection acts as against the provider. */
export type ConnectionSubjectType =
  "app" | "user" | "federated" | "person" | "workspace";

/** Subjects currently accepted by registered connection creation. */
export type ConnectionCreateSubjectType = "app" | "user";

/** Subjects currently accepted by authorize and token-broker operations. */
export type ConnectionBrokerSubjectType = "app" | "user" | "person";

export type ConnectorPersonServerMode = "managed" | "byo" | "discovered";

export type ConnectorApprovalPolicy =
  "human" | "judge_advises_human" | "judge_auto_within_envelope";

/**
 * A connector — a project-scoped integration to an external provider
 * (e.g. Slack, Gmail, Stripe) that connections are minted under.
 *
 * `client_secret` and `signing_secret` are write-only: accepted on create
 * and update, absent from every response — this read model deliberately
 * does not declare them.
 */
export interface Connector {
  id: Uuid;
  org_id: Uuid;
  project_id: Uuid;
  created_at: IsoDate;
  updated_at: IsoDate;
  /** Stable per-org identifier; create is idempotent on it. */
  slug: string;
  name: string;
  /** Provider slug, e.g. `"slack"`, `"gmail"`, `"stripe"`. */
  provider: string;
  auth_mode: ConnectorAuthMode;
  /** Create-time fact — not updatable. */
  environment: Environment;
  agent_member_id?: Uuid | null;
  authorization_endpoint?: string | null;
  token_endpoint?: string | null;
  scopes: string[];
  api_hosts: string[];
  client_id?: string | null;
  person_server_mode?: ConnectorPersonServerMode | null;
  person_server_url?: string | null;
  approval_policy: ConnectorApprovalPolicy;
  application_id?: Uuid | null;
  assertion_audience?: string | null;
  webhook_url?: string | null;
  status: ConnectorStatus;
  created_by_member_id?: Uuid | null;
  metadata?: Record<string, unknown> | null;
  /**
   * Server-derived: whether `authorize` must name a `runtime` for this
   * connector (chat providers need the agent that replies). Read this —
   * never hardcode a provider list.
   */
  requires_runtime: boolean;
}

export interface ConnectorCreateParams {
  name: string;
  /** Provider slug, e.g. `"slack"`, `"gmail"`, `"stripe"`. */
  provider: string;
  auth_mode: ConnectorAuthMode;
  /** Derived from `name` when omitted. */
  slug?: string;
  /** Lane the connector serves (default `"production"`). */
  environment?: Environment;
  agent_member_id?: Uuid;
  authorization_endpoint?: string;
  token_endpoint?: string;
  scopes?: string[];
  api_hosts?: string[];
  client_id?: string;
  /** Write-only — never present on any response. */
  client_secret?: string;
  /** Write-only — never present on any response. */
  signing_secret?: string;
  metadata?: Record<string, unknown>;
  /**
   * OAuth discovery: when set and the endpoints are omitted, the server
   * resolves `authorization_endpoint` / `token_endpoint` from the issuer's
   * `.well-known` metadata. Not persisted.
   */
  issuer?: string;
  person_server_mode?: ConnectorPersonServerMode;
  person_server_url?: string;
  approval_policy?: ConnectorApprovalPolicy;
  application_id?: Uuid;
  assertion_audience?: string;
  webhook_url?: string;
}

/**
 * PATCH body — only these fields are mutable (`environment`, `provider`,
 * `auth_mode`, and `slug` are create-time facts). Only provided fields
 * change; leaving `client_secret` / `signing_secret` blank means
 * "unchanged", not "clear".
 */
export interface ConnectorUpdateParams {
  name?: string;
  agent_member_id?: Uuid;
  scopes?: string[];
  api_hosts?: string[];
  status?: ConnectorStatus;
  metadata?: Record<string, unknown>;
  webhook_url?: string;
  /** Write-only; omit to leave the stored secret unchanged. */
  client_secret?: string;
  /** Write-only; omit to leave the stored secret unchanged. */
  signing_secret?: string;
}

export type ConnectorListParams = CursorParams;

export interface ConnectorAuthorizeParams {
  /**
   * The end customer this grant is being made for, asserted by the caller.
   * Its `user_id` resolves a `customer` member recorded as the connection's
   * `created_by_member_id`, so a partner can associate the connection with
   * their own caller rather than the agent member that made the API call.
   * Omit to attribute the grant to the authenticated principal.
   */
  identity?: RunIdentityInput;
  /**
   * Runtime selector (slug or runtime group id). Required by the server
   * (422) when the connector's provider is a chat provider — check
   * `connector.requires_runtime`.
   */
  runtime?: string;
  /** Who the consent is for (default `"app"`). */
  subject?: ConnectionBrokerSubjectType;
  /** Where the browser lands after consent. */
  return_url?: string;
  /**
   * Seconds the URL stays valid (60–86400, server default 600). Raise it
   * when handing the URL to someone else to open.
   */
  expires_in?: number;
}

/**
 * A freshly minted consent URL. The URL embeds a single-use `state`, so it
 * must never be cached, and `state` itself is never surfaced as a field.
 */
export interface ConnectorAuthorizeResponse {
  authorize_url: string;
  expires_in: number;
  expires_at: IsoDate;
}

/**
 * A connection — one authorized subject under a connector. Access and
 * refresh tokens are never serialized.
 */
export interface Connection {
  id: Uuid;
  org_id: Uuid;
  created_at: IsoDate;
  updated_at: IsoDate;
  connector_id: Uuid;
  /**
   * `null` = org-owned (app subject); for a Slack workspace install this
   * points at the workspace customer member.
   */
  member_id?: Uuid | null;
  /**
   * The member who performed the grant, as distinct from `member_id` (whose
   * credential this is). For `app` and `workspace` subjects those are never
   * the same principal. `null` for grants made before the column existed.
   */
  created_by_member_id?: Uuid | null;
  /** Runtime group answering this connection's channels. */
  runtime_group_id?: Uuid | null;
  subject_type: ConnectionSubjectType;
  scopes_granted: string[];
  status: ConnectionStatus;
  token_expires_at?: IsoDate | null;
}

/** Registered-mode create — the caller supplies a provider token. */
export interface ConnectionCreateParams {
  access_token: string;
  /** Defaults to `"app"`. */
  subject_type?: ConnectionCreateSubjectType;
  scopes_granted?: string[];
  refresh_token?: string;
  token_expires_at?: IsoDate;
}

/** Deterministic, non-PII envelope for a person-authorized action. */
export interface ConnectionMissionConstraints {
  host?: string;
  /** Opaque or hashed resource identifier; never raw PII. */
  resource?: string;
  limits?: Record<string, unknown>;
  window_start?: IsoDate;
  window_end?: IsoDate;
  /** SHA-256 of the approved artifact. */
  payload_binding?: string;
}

export interface ConnectionTokenParams {
  /** Defaults to `"app"`. */
  subject?: ConnectionBrokerSubjectType;
  /** Mission label shown to the human for person-authorized connectors. */
  action?: string;
  requested_permissions?: ConnectionMissionConstraints;
}

export interface ConnectionToken {
  token: string;
  token_type: string;
  expires_at?: IsoDate | null;
  scopes: string[];
}

export interface ConnectionAuthorizationPending {
  status: "authorization_pending";
  mission_id: Uuid;
  approval_url: string;
}

export type ConnectionTokenResult =
  ConnectionToken | ConnectionAuthorizationPending;

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
