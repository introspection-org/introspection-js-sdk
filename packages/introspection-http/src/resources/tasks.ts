import type {
  Paginated,
  Task,
  TaskCancelResponse,
  TaskCancelOptions,
  TaskCreateParams,
  TaskCreateResponse,
  TaskListParams,
  TaskRun,
  TaskRunCreateParams,
  TaskRunResumeParams,
  TaskRunResponse,
  TaskUpdateParams,
} from "@introspection-sdk/types";
import { EventType, type AGUIEvent } from "@ag-ui/core";
import { Paginator, cursorPaginate } from "../pagination.js";
import { streamResumable, type StreamOptions } from "../resumable.js";
import type { ResourceHttpClient } from "./types.js";

export interface StartParams extends TaskCreateParams {
  prompt: string;
}

export type TaskBodyMapper<TCreate> = (
  body: TCreate,
) => Record<string, unknown>;

function identityTaskBody<TCreate extends object>(
  body: TCreate,
): Record<string, unknown> {
  return body as Record<string, unknown>;
}

/**
 * Header carrying the raw Development Link secret (`dl_…`) on
 * task-creating requests, so the platform routes the task's sandbox to
 * the developer's live local recipe overlay (`introspection dev`). The
 * link changes overlay routing only — auth is unchanged.
 */
export const DEVELOPMENT_LINK_HEADER = "Introspection-Development-Link";

export interface TaskClientOptions {
  /**
   * Development Link secret (`dl_…`) pairing this app instance to a local
   * recipe checkout. When set, it is sent as the
   * {@link DEVELOPMENT_LINK_HEADER} header on task-creating requests only
   * (task create and run create) — never on reads or other mutations.
   */
  developmentLink?: string;
}

/**
 * `request()` fragment carrying the Development Link header, or an empty
 * fragment when no link is configured — spread into task-creating
 * requests so unset/empty links add no `headers` key at all.
 */
function developmentLinkHeaders(
  developmentLink: string | undefined,
): { headers: Record<string, string> } | Record<string, never> {
  if (!developmentLink) return {};
  return { headers: { [DEVELOPMENT_LINK_HEADER]: developmentLink } };
}

export class RunHandle {
  constructor(
    public readonly task: Task | null,
    public readonly run: TaskRun,
    private readonly runs: TaskRunsClient,
  ) {}

  stream(opts?: StreamOptions): AsyncIterable<AGUIEvent> {
    return this.runs.stream(this.run.task_id, this.run.id, opts);
  }

  cancel(options?: TaskCancelOptions): Promise<TaskCancelResponse> {
    return this.runs.cancel(this.run.task_id, this.run.id, options);
  }

  /** Convenience: collect assistant text deltas from the AG-UI stream. */
  async text(): Promise<string> {
    let out = "";
    for await (const ev of this.stream()) {
      if (
        ev.type === EventType.TEXT_MESSAGE_CONTENT ||
        ev.type === EventType.TEXT_MESSAGE_CHUNK
      ) {
        out += ev.delta ?? "";
      }
    }
    return out;
  }
}

export class TaskRunsClient {
  constructor(
    private readonly http: ResourceHttpClient,
    private readonly options: TaskClientOptions = {},
  ) {}

  async create(taskId: string, body: TaskRunCreateParams): Promise<RunHandle> {
    const res = await this.http.request<TaskRunResponse>({
      method: "POST",
      path: `/v1/tasks/${encodeURIComponent(taskId)}/runs`,
      body,
      ...developmentLinkHeaders(this.options.developmentLink),
    });
    return new RunHandle(null, res.run, this);
  }

  async resume(taskId: string, body: TaskRunResumeParams): Promise<RunHandle> {
    const res = await this.http.request<TaskRunResponse>({
      method: "POST",
      path: `/v1/tasks/${encodeURIComponent(taskId)}/runs`,
      body,
      ...developmentLinkHeaders(this.options.developmentLink),
    });
    return new RunHandle(null, res.run, this);
  }

  get(taskId: string, runId: string): Promise<TaskRun> {
    return this.http.request<TaskRun>({
      method: "GET",
      path: `/v1/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}`,
    });
  }

  cancel(
    taskId: string,
    runId: string,
    options?: TaskCancelOptions,
  ): Promise<TaskCancelResponse> {
    return this.http.request<TaskCancelResponse>({
      method: "POST",
      path: `/v1/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/cancel`,
      ...(options ? { body: { mode: "abort", ...options } } : {}),
    });
  }

  /**
   * Stream a run's AG-UI events. The stream resumes **transparently** across a
   * mid-turn disconnect (gateway idle-timeout, load-balancer recycle, network
   * blip): it re-attaches with the SSE-standard `Last-Event-ID` so the server
   * replays the missed frames, yielding a single gap-free `AGUIEvent` sequence
   * (INT-252, see `docs/design/sdk-resumable-streams.md`). The iterator
   * completes when the turn finishes and throws only once recovery is
   * exhausted — there is no consumer-visible change from a plain stream.
   * `opts` tunes the recovery bounds.
   */
  stream(
    taskId: string,
    runId: string,
    opts?: StreamOptions,
  ): AsyncIterable<AGUIEvent> {
    return streamResumable(this.http, taskId, runId, opts);
  }
}

export class TasksClient<
  TCreate extends object = TaskCreateParams,
  TStart extends TCreate & { prompt: string } = TCreate & { prompt: string },
> {
  readonly runs: TaskRunsClient;
  private readonly mapTaskBody: TaskBodyMapper<TCreate>;
  private readonly options: TaskClientOptions;

  constructor(
    private readonly http: ResourceHttpClient,
    mapTaskBody: TaskBodyMapper<TCreate> = identityTaskBody,
    options: TaskClientOptions = {},
  ) {
    this.runs = new TaskRunsClient(http, options);
    this.mapTaskBody = mapTaskBody;
    this.options = options;
  }

  /**
   * List tasks matching `params`. `await` the result for the first page,
   * or `for await` it to stream every task across pages (fetched lazily —
   * `limit` sets the page size, `next` the starting cursor; stop early to
   * stop fetching).
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

  create(body: TCreate): Promise<TaskCreateResponse> {
    return this.http.request<TaskCreateResponse>({
      method: "POST",
      path: "/v1/tasks",
      body: this.mapTaskBody(body),
      ...developmentLinkHeaders(this.options.developmentLink),
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

  /** Cursor-style sugar: create a task + return a handle on its initial run. */
  async start(params: TStart): Promise<RunHandle> {
    const res = await this.create(params);
    return new RunHandle(res.task, res.run, this.runs);
  }
}

export { TasksClient as TasksApi, TaskRunsClient as TaskRunsApi };
