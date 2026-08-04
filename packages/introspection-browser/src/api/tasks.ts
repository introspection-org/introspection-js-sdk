import type {
  RunIdentityInput,
  TaskCreateResponse,
  TaskRunCreateParams,
  Uuid,
} from "@introspection-sdk/types";
import {
  RunHandle,
  TaskRunsClient as SharedTaskRunsClient,
  TasksClient as SharedTasksClient,
  type ResourceHttpClient,
  type TaskRequestOptions,
} from "@introspection-sdk/http";

/**
 * Body for creating a task directly against the DP from the browser.
 *
 * A browser caller has no pre-pinned `Runner`, so — unlike the Node
 * SDK's runner-bound create — it selects the agent itself: pass
 * `runtime_id` to pin a recipe runtime, or `agent_name` to fall back to
 * a named recipe agent. `identity` is a convenience that is folded into
 * `metadata.identity` for attribution (the DP derives the owning
 * `identity_key` from the session's JWT claims, never from this body).
 */
export interface CreateTaskParams {
  prompt?: string;
  /** Pin the task to a specific recipe runtime. */
  runtime_id?: Uuid;
  /** Named recipe agent, when no `runtime_id` is pinned. */
  agent_name?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  /**
   * Override the interactive idle window (seconds) before the sandbox is
   * torn down. `0` tears down as soon as it's provisioned; omit to use the
   * deployment default. Clamped to the task timeout.
   */
  idle_timeout_seconds?: number;
  /** Caller identity for attribution; merged into `metadata.identity`. */
  identity?: RunIdentityInput;
  /**
   * Fork from a shared conversation: the `/v1/shares` grant id for the source
   * conversation. Its presence makes this create a fork — the server seeds the
   * new task with that conversation's history, read via the share (the
   * permissions boundary).
   */
  fork_share_id?: string;
}

export interface StartTaskParams extends CreateTaskParams {
  /** Required for the `start()` sugar that returns a run handle. */
  prompt: string;
}

/**
 * Hook the session-lifecycle client threads into the tasks client so a
 * create is preceded by a session freshness check (re-broker + re-exchange
 * when the bootstrap is expired or invalidated). Internal seam — not part
 * of the public surface.
 */
export type BeforeTaskCreateHook = () => Promise<void>;

function toTaskBody(params: CreateTaskParams): Record<string, unknown> {
  const { identity, metadata, ...rest } = params;
  const body: Record<string, unknown> = { ...rest };
  const mergedMetadata = identity
    ? { ...(metadata ?? {}), identity }
    : metadata;
  if (mergedMetadata !== undefined) body.metadata = mergedMetadata;
  return body;
}

/**
 * Attach an auto-generated `Idempotency-Key` unless the caller supplied
 * one. The key is minted once per logical create, so the transport's
 * single 401-refresh retry re-sends the SAME key — the server can
 * de-duplicate a create that raced a session refresh.
 */
function withIdempotencyKey(opts?: TaskRequestOptions): TaskRequestOptions {
  const headers = { ...(opts?.headers ?? {}) };
  headers["Idempotency-Key"] =
    headers["Idempotency-Key"] ?? globalThis.crypto.randomUUID();
  return { ...opts, headers };
}

/** Cookie-session `/v1/tasks/{id}/runs` client with per-create idempotency keys. */
export class TaskRunsClient extends SharedTaskRunsClient {
  constructor(
    http: ResourceHttpClient,
    private readonly beforeCreate?: BeforeTaskCreateHook,
  ) {
    super(http);
  }

  override async create(
    taskId: string,
    body: TaskRunCreateParams,
    opts?: TaskRequestOptions,
  ): Promise<RunHandle> {
    await this.beforeCreate?.();
    return super.create(taskId, body, withIdempotencyKey(opts));
  }
}

/**
 * Cookie-authenticated `/v1/tasks` client. The implementation is shared with
 * Node's runner-bound task client; this browser subclass adds the
 * `identity -> metadata.identity` body mapping used by cookie-session calls,
 * a per-create auto-generated `Idempotency-Key`, and an optional pre-create
 * session-freshness hook installed by the lifecycle-managed client.
 */
export class TasksClient extends SharedTasksClient<
  CreateTaskParams,
  StartTaskParams
> {
  private readonly beforeCreate?: BeforeTaskCreateHook;

  constructor(http: ResourceHttpClient, beforeCreate?: BeforeTaskCreateHook) {
    super(http, toTaskBody, new TaskRunsClient(http, beforeCreate));
    this.beforeCreate = beforeCreate;
  }

  override async create(
    body: CreateTaskParams,
    opts?: TaskRequestOptions,
  ): Promise<TaskCreateResponse> {
    await this.beforeCreate?.();
    return super.create(body, withIdempotencyKey(opts));
  }
}

export { RunHandle };
