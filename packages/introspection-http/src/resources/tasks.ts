import type {
  Paginated,
  Task,
  TaskCancelResponse,
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
import { parseAgUiEvents } from "../agui-stream.js";
import {
  streamTurnResumable,
  type ResumableTurnEvent,
  type StreamTurnOptions,
} from "../resumable.js";
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

export class RunHandle {
  constructor(
    public readonly task: Task | null,
    public readonly run: TaskRun,
    private readonly runs: TaskRunsClient,
  ) {}

  stream(): AsyncIterable<AGUIEvent> {
    return this.runs.stream(this.run.task_id, this.run.id);
  }

  /**
   * Consume this run as a resilient turn (see
   * {@link TaskRunsClient.streamTurn}). With `resume: true` a mid-turn
   * disconnect is transparently recovered from the durable transcript.
   */
  streamTurn(opts?: StreamTurnOptions): AsyncIterable<ResumableTurnEvent> {
    return this.runs.streamTurn(this.run.task_id, this.run.id, opts);
  }

  cancel(): Promise<TaskCancelResponse> {
    return this.runs.cancel(this.run.task_id, this.run.id);
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
  constructor(private readonly http: ResourceHttpClient) {}

  async create(taskId: string, body: TaskRunCreateParams): Promise<RunHandle> {
    const res = await this.http.request<TaskRunResponse>({
      method: "POST",
      path: `/v1/tasks/${encodeURIComponent(taskId)}/runs`,
      body,
    });
    return new RunHandle(null, res.run, this);
  }

  async resume(taskId: string, body: TaskRunResumeParams): Promise<RunHandle> {
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

  async *stream(taskId: string, runId: string): AsyncIterable<AGUIEvent> {
    const res = await this.http.stream({
      path: `/v1/tasks/${encodeURIComponent(taskId)}/runs/${encodeURIComponent(runId)}/stream`,
    });
    yield* parseAgUiEvents(res);
  }

  /**
   * Consume a run as a resilient turn with graceful resume (INT-252, see
   * `docs/design/sdk-resumable-streams.md`). The plain {@link stream} surfaces
   * a mid-turn disconnect as a turn failure and loses every event between the
   * drop and a manual retry; with `opts.resume = true` this transparently
   * catches the missed output up from the durable transcript and re-attaches
   * the live stream, yielding a single gap-free, duplicate-free sequence of
   * {@link ResumableTurnEvent}s — bounded by `maxResumes`/`timeoutMs` so it
   * never reconnects forever.
   *
   * Resume is opt-in (`resume` defaults to `false`); the default behaviour is
   * a single streamed turn, unchanged from {@link stream}.
   */
  streamTurn(
    taskId: string,
    runId: string,
    opts?: StreamTurnOptions,
  ): AsyncIterable<ResumableTurnEvent> {
    return streamTurnResumable(this.http, taskId, runId, opts);
  }
}

export class TasksClient<
  TCreate extends object = TaskCreateParams,
  TStart extends TCreate & { prompt: string } = TCreate & { prompt: string },
> {
  readonly runs: TaskRunsClient;
  private readonly mapTaskBody: TaskBodyMapper<TCreate>;

  constructor(
    private readonly http: ResourceHttpClient,
    mapTaskBody: TaskBodyMapper<TCreate> = identityTaskBody,
  ) {
    this.runs = new TaskRunsClient(http);
    this.mapTaskBody = mapTaskBody;
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

  /**
   * Consume a run as a resilient turn with graceful resume — sugar for
   * {@link TaskRunsClient.streamTurn}. With `opts.resume = true` a mid-turn
   * disconnect is recovered transparently from the durable transcript; resume
   * is opt-in and defaults off.
   */
  streamTurn(
    taskId: string,
    runId: string,
    opts?: StreamTurnOptions,
  ): AsyncIterable<ResumableTurnEvent> {
    return this.runs.streamTurn(taskId, runId, opts);
  }

  /** Cursor-style sugar: create a task + return a handle on its initial run. */
  async start(params: TStart): Promise<RunHandle> {
    const res = await this.create(params);
    return new RunHandle(res.task, res.run, this.runs);
  }
}

export { TasksClient as TasksApi, TaskRunsClient as TaskRunsApi };
