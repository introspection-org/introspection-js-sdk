import type { RunIdentityInput } from "@introspection-sdk/types";
import {
  RunHandle,
  TaskRunsClient,
  TasksClient as SharedTasksClient,
  type ResourceHttpClient,
} from "@introspection-sdk/http";

/**
 * Body for creating a task directly against the DP from the browser.
 *
 * Project-session task creation does not select a Runtime. Runtime authority
 * comes from a Runner bearer; `agent_name` only selects an agent within the
 * deployment's baked Recipe. `identity` remains metadata attribution only
 * (the DP derives owning identity from authenticated claims).
 */
export interface CreateTaskParams {
  prompt?: string;
  /** Named recipe agent within the deployment's baked Recipe. */
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
