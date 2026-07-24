import {
  RunHandle,
  TaskRunsClient,
  TasksClient as SharedTasksClient,
  type ResourceHttpClient,
} from "@introspection-sdk/http";

/**
 * Body for creating a task directly against the DP from the browser.
 *
 * The browser session is already bound to a Runtime during
 * `IntrospectionApiClient.connect()`. `agent_name` optionally selects an
 * agent within that Runtime. Identity and authorization come from the
 * session credential, never from this body.
 */
export interface CreateTaskParams {
  prompt?: string;
  /** Named recipe agent within the session-bound Runtime. */
  agent_name?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  /**
   * Override the interactive idle window (seconds) before the sandbox is
   * torn down. `0` tears down as soon as it's provisioned; omit to use the
   * deployment default. Clamped to the task timeout.
   */
  idle_timeout_seconds?: number;
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
 * Cookie-authenticated `/v1/tasks` client. The implementation is shared with
 * Node's runner-bound task client, with a browser-specific create shape.
 */
export class TasksClient extends SharedTasksClient<
  CreateTaskParams,
  StartTaskParams
> {
  constructor(http: ResourceHttpClient) {
    super(http);
  }
}

export { RunHandle, TaskRunsClient };
