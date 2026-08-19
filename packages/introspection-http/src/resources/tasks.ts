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
import { ValidationError } from "@introspection-sdk/types";
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
 * Fold the flat `conversation_metadata` param into the nested
 * `metadata.conversation` the API takes.
 *
 * The nesting is a wire constraint, not a thing callers should have to model:
 * `metadata` is a shared bag the platform also writes into, so the caller's
 * filter dimensions need their own level to keep the two apart. Nothing about
 * that is the caller's problem, so it is resolved here.
 *
 * Applied after the injected body mapper so every client gets it, not only
 * those using the default mapper.
 */
export function foldConversationMetadata(
  body: Record<string, unknown>,
): Record<string, unknown> {
  if (body.conversation_metadata === undefined) return body;
  const { conversation_metadata, ...rest } = body;
  const metadata = (rest.metadata ?? {}) as Record<string, unknown>;
  // Both spellings set is refused rather than merged or silently preferred.
  // They mean the same thing, so a caller who set both has two sources of
  // truth for one field, and picking either would be a guess that fails
  // quietly — the dimension they did not expect simply never appears.
  if (metadata.conversation !== undefined) {
    throw new ValidationError({
      message:
        "Set either `conversation_metadata` or `metadata.conversation`, not both — they are the same field. Prefer `conversation_metadata`.",
      status: 422,
      code: "invalid_request",
    });
  }
  return {
    ...rest,
    metadata: { ...metadata, conversation: conversation_metadata },
  };
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
   * (INT-252). The iterator
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
      body: foldConversationMetadata(this.mapTaskBody(body)),
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
      // A PATCH can introduce `conversation` after create, and the projection reads
      // the persisted row at spawn, so the flat spelling has to work here too.
      body: foldConversationMetadata(body as Record<string, unknown>),
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
