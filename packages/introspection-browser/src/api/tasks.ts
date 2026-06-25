import type { RunIdentityInput, Uuid } from "@introspection-sdk/types";
import {
  RunHandle,
  TaskRunsClient,
  TasksClient as SharedTasksClient,
  type ResourceHttpClient,
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
 * Cookie-authenticated `/v1/tasks` client. The implementation is shared with
 * Node's runner-bound task client; this browser subclass only adds the
 * `identity -> metadata.identity` body mapping used by cookie-session calls.
 */
export class TasksClient extends SharedTasksClient<
  CreateTaskParams,
  StartTaskParams
> {
  constructor(http: ResourceHttpClient) {
    super(http, toTaskBody);
  }
}

export { RunHandle, TaskRunsClient };
