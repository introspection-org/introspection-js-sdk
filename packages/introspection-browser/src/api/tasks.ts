import type {
  Paginated,
  RunIdentityInput,
  SseEvent,
  Task,
  TaskCancelResponse,
  TaskCreateResponse,
  TaskListParams,
  TaskRun,
  TaskRunCreateParams,
  TaskRunResponse,
  TaskUpdateParams,
  TaskVisibility,
} from "@introspection-sdk/types";
import { Paginator, cursorPaginate } from "@introspection-sdk/http";
import { BrowserHttpClient } from "./http.js";
import { parseSse } from "./sse.js";

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
  runtime_id?: string;
  /** Named recipe agent, when no `runtime_id` is pinned. */
  agent_name?: string;
  title?: string;
  metadata?: Record<string, unknown>;
  visibility?: TaskVisibility;
  /** Caller identity for attribution; merged into `metadata.identity`. */
  identity?: RunIdentityInput;
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

/** Live handle on a task's run: stream its events, collect text, cancel. */
export class RunHandle {
  constructor(
    public readonly task: Task | null,
    public readonly run: TaskRun,
    private readonly runs: TaskRunsClient,
  ) {}

  stream(): AsyncIterable<SseEvent> {
    return this.runs.stream(this.run.task_id, this.run.id);
  }

  cancel(): Promise<TaskCancelResponse> {
    return this.runs.cancel(this.run.task_id, this.run.id);
  }

  /** Convenience: concatenate `data` from `text`/`message` SSE frames. */
  async text(): Promise<string> {
    let out = "";
    for await (const ev of this.stream()) {
      if (ev.event === "text" || ev.event === "message") out += ev.data;
    }
    return out;
  }
}

export class TaskRunsClient {
  constructor(private readonly http: BrowserHttpClient) {}

  async create(taskId: string, body: TaskRunCreateParams): Promise<RunHandle> {
    const res = await this.http.request<TaskRunResponse>({
      method: "POST",
      path: `/v1/tasks/${encodeURIComponent(taskId)}/runs`,
      body,
    });
    return new RunHandle(null, res.run, this);
  }

  get(taskId: string, runId: string): Promise<TaskRun> {
    return this.http.request<TaskRun>({
      method: "GET",
      path: `/v1/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}`,
    });
  }

  cancel(taskId: string, runId: string): Promise<TaskCancelResponse> {
    return this.http.request<TaskCancelResponse>({
      method: "POST",
      path: `/v1/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/cancel`,
    });
  }

  async *stream(taskId: string, runId: string): AsyncIterable<SseEvent> {
    const res = await this.http.stream({
      path: `/v1/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/stream`,
    });
    yield* parseSse(res);
  }
}

/**
 * Cookie-authenticated `/v1/tasks` client. Mirrors the Node SDK's
 * `TasksApi` shape but is bound to a DP session cookie rather than a
 * bearer token, and lets the caller select the agent on create.
 */
export class TasksClient {
  readonly runs: TaskRunsClient;

  constructor(private readonly http: BrowserHttpClient) {
    this.runs = new TaskRunsClient(http);
  }

  /**
   * Tasks matching `params`. `await` it for the first page (preserving
   * the wire envelope's counts + `next` cursor), or `for await` it to
   * stream every task across pages (fetched lazily — `limit` sets the
   * page size, `next` the starting cursor; stop early to stop fetching).
   *
   * Mirrors the Node SDK's `TasksApi.list`, which is the source of truth
   * for the `/v1/tasks` shape.
   */
  list(params?: TaskListParams): Paginator<Task> {
    return cursorPaginate(
      (next) =>
        this.http.request<Paginated<Task>>({
          method: "GET",
          path: "/v1/tasks",
          query: { ...params, next } as Record<string, unknown>,
        }),
      params?.next,
    );
  }

  create(body: CreateTaskParams): Promise<TaskCreateResponse> {
    return this.http.request<TaskCreateResponse>({
      method: "POST",
      path: "/v1/tasks",
      body: toTaskBody(body),
    });
  }

  get(taskId: string): Promise<Task> {
    return this.http.request<Task>({
      method: "GET",
      path: `/v1/tasks/${encodeURIComponent(taskId)}`,
    });
  }

  update(taskId: string, body: TaskUpdateParams): Promise<Task> {
    return this.http.request<Task>({
      method: "PATCH",
      path: `/v1/tasks/${encodeURIComponent(taskId)}`,
      body,
    });
  }

  delete(taskId: string): Promise<void> {
    return this.http.request<void>({
      method: "DELETE",
      path: `/v1/tasks/${encodeURIComponent(taskId)}`,
      expect: "empty",
    });
  }

  archive(taskId: string): Promise<void> {
    return this.http.request<void>({
      method: "POST",
      path: `/v1/tasks/${encodeURIComponent(taskId)}/archive`,
      expect: "empty",
    });
  }

  unarchive(taskId: string): Promise<void> {
    return this.http.request<void>({
      method: "POST",
      path: `/v1/tasks/${encodeURIComponent(taskId)}/unarchive`,
      expect: "empty",
    });
  }

  /** Sugar: create a task + return a handle on its initial run. */
  async start(params: StartTaskParams): Promise<RunHandle> {
    const res = await this.create(params);
    return new RunHandle(res.task, res.run, this.runs);
  }
}
