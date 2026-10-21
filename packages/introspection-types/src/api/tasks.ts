import type { ResumeEntry } from "@ag-ui/core";
import type { CursorParams, IsoDate, ListParams, Uuid } from "./common.js";

/**
 * The execution shape of a task.
 *
 * `agent` boots the runtime-agent image and runs an interactive LLM agent;
 * `eval` is the same shape run as an evaluation trial, governed separately at
 * admission; `process` runs a one-shot baked script and reports through the
 * same completion path, and is internal-only. This replaced the retired
 * `TaskMode`: there are no task modes any more — every agent task is a
 * conversation, and the recipe agent is selected by `agent_name`.
 */
export type TaskKind = "agent" | "eval" | "process";

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
  /** Immutable filter dimensions stamped onto this task's conversation. */
  conversation_metadata?: Record<string, string> | null;
  agent?: AgentInfo | null;
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
  /**
   * Omit for an agent task. `eval` needs the `evals` capability and is the
   * only kind that takes {@link TaskCreateParams.commands}; `process` is
   * internal and refused.
   */
  kind?: Exclude<TaskKind, "process">;
  /** Consent to `tasks.commands` against the live sandbox; eval tasks only. */
  commands?: boolean;
  /** Recipe agent to run; omit for the recipe default (`agents/agent.yaml`). */
  agent_name?: string;
  /**
   * Runtime to bind the task to. Needed by a caller whose token names no
   * runtime (an API key, a signed-in member's session); ignored for a runner,
   * whose token already does. Validated against the token's project.
   */
  runtime_id?: Uuid;
  /**
   * Workspace repositories to clone into the sandbox's `workspace/repos/`
   * before the first turn. No count limit — the server refuses a statically
   * wrong list (duplicate slugs, folder collisions), not a long one.
   */
  repositories?: TaskRepoRequest[];
  /**
   * Free-form task metadata. A mutable bag the platform also writes into
   * (`last_response`, `conversation_id`, ...); nothing here is projected onto
   * telemetry. For conversation filter dimensions use
   * {@link TaskCreateParams.conversation_metadata}.
   */
  metadata?: Record<string, unknown>;
  /**
   * Conversation filter dimensions for this task.
   *
   * ```ts
   * await client.tasks.create({ prompt, conversation_metadata: { flow: "checkout" } });
   * await client.conversations.list({ metadata: { flow: "checkout" } });
   * ```
   *
   * Stamped onto every span of the run, so the conversation this task produces
   * is filterable by any pair here. This is a first-class task-create field;
   * ordinary `metadata` remains mutable task data and is never projected.
   *
   * An entry lands when its key is one level (`[A-Za-z0-9_-]`, **no `.`** — a
   * dot is rejected outright, because ClickHouse would store `user.tier`
   * nested and the key you filter by would not be the key that was kept) and
   * its value is a non-empty string of at most 1024 characters; at most 64
   * keys. The server rejects an invalid entry with HTTP 422 rather than
   * accepting the task and silently dropping the dimension.
   *
   * Note that these land in **append-only telemetry**, which unlike the
   * `metadata` bag cannot later be edited or deleted.
   */
  conversation_metadata?: Record<string, string>;
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
   * Filter with {@link TaskListParams.tag}. A caller whose member tags
   * intersect a row's tags can still read and write it implicitly, but that
   * implicit tag access is deprecated and being retired: to share with a
   * cohort, create a tag share instead (`shares.create({ granted_tag })`).
   * Shared writers may not replace the tags themselves; that remains
   * owner/privileged-only.
   */
  tags?: string[];
  /**
   * Fork from a shared conversation: the `/v1/shares` grant id for the source
   * conversation. Its presence makes this create a fork — the new task is seeded
   * with that conversation's history, read via the share (the permissions
   * boundary). A share carrying `visible_from` cannot be forked (409).
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

export type TaskCommandKind = "exec" | "upload" | "download";

/** `completed` and `failed` are terminal. */
export type TaskCommandStatus = "queued" | "running" | "completed" | "failed";

/**
 * Run an argv (never a shell string) and record its exit code and output.
 * `service` names a compose service; omit it (or `main`) for the agent's own
 * container.
 */
export interface ExecTaskCommand {
  kind: "exec";
  command: string[];
  cwd?: string;
  /** Defaults to 300. */
  timeout_seconds?: number;
  service?: string;
}

/** Copy a Files API object to an absolute `path` inside the sandbox. */
export interface UploadTaskCommand {
  kind: "upload";
  file_id: Uuid;
  path: string;
}

/**
 * Copy the file at an absolute `path` out into a new Files API object,
 * reported as {@link TaskCommand.output_file_id}.
 */
export interface DownloadTaskCommand {
  kind: "download";
  path: string;
  service?: string;
}

/** `POST /v1/tasks/{id}/commands` body, tagged by `kind`. */
export type TaskCommandSpec =
  ExecTaskCommand | UploadTaskCommand | DownloadTaskCommand;

/** A recorded task command and, once terminal, its outcome. */
export interface TaskCommand {
  id: Uuid;
  task_id: Uuid;
  kind: TaskCommandKind;
  /** The spec as the API normalized it. */
  spec: Record<string, unknown>;
  status: TaskCommandStatus;
  exit_code?: number | null;
  stdout?: string | null;
  stderr?: string | null;
  output_file_id?: Uuid | null;
  error?: string | null;
  created_at: IsoDate;
  updated_at: IsoDate;
  started_at?: IsoDate | null;
  finished_at?: IsoDate | null;
}

/** `GET /v1/tasks/{id}/commands` filters. */
export interface TaskCommandListParams extends CursorParams {
  status?: TaskCommandStatus;
}

/** `GET /v1/tasks/{id}/commands/{command_id}` options. */
export interface TaskCommandGetOptions {
  /**
   * Hold the read until the command finishes or this many seconds pass, and
   * return it in whatever state it is then. Capped at
   * `MAX_COMMAND_WAIT_SECONDS`; call again to wait longer.
   */
  wait_seconds?: number;
}
