import {
  RunFailedError,
  StreamIncompleteError,
} from "@introspection-sdk/types";
import type {
  Task,
  TaskCancelResponse,
  TaskCancelOptions,
  TaskCommand,
  TaskCommandGetOptions,
  TaskCommandListParams,
  TaskCommandSpec,
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
import { Paginator, paginateGet } from "../pagination.js";
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

  /**
   * Collect the run's assistant text from the AG-UI stream. A
   * `MESSAGES_SNAPSHOT` replaces what was read, `RUN_ERROR` throws
   * `RunFailedError`, `resume_gap` throws `StreamIncompleteError`, and every
   * error the stream throws propagates, so it never returns partial text.
   * Recover final output from the conversation transcript when needed; this
   * does not hydrate it or require `conversations:read`.
   */
  async text(): Promise<string> {
    let out = "";
    for await (const ev of this.stream()) {
      if (ev.type === EventType.RUN_ERROR)
        throw new RunFailedError(ev.message, ev.code);
      if (ev.type === EventType.CUSTOM && ev.name === "resume_gap")
        throw new StreamIncompleteError(
          "The replay buffer lost output; read the conversation transcript",
        );
      // A snapshot carries the whole run so far, so it replaces what was read.
      if (ev.type === EventType.MESSAGES_SNAPSHOT) {
        out = ev.messages
          .map((m) =>
            m.role === "assistant" && typeof m.content === "string"
              ? m.content
              : "",
          )
          .join("");
        continue;
      }
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

  create(taskId: string, body: TaskRunCreateParams): Promise<RunHandle> {
    return this.postRun(taskId, body);
  }

  resume(taskId: string, body: TaskRunResumeParams): Promise<RunHandle> {
    return this.postRun(taskId, body);
  }

  private async postRun(
    taskId: string,
    body: TaskRunCreateParams | TaskRunResumeParams,
  ): Promise<RunHandle> {
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

  /** Stream a run with bounded reconnects and replay from its first content frame.
   * Output past the replay buffer arrives as a `MESSAGES_SNAPSHOT`. Only a settling
   * event confirms completion; a nonterminal EOF checks this run's status.
   */
  stream(
    taskId: string,
    runId: string,
    opts?: StreamOptions,
  ): AsyncIterable<AGUIEvent> {
    return streamResumable(this.http, taskId, runId, opts);
  }
}

/**
 * The longest {@link TaskCommandsClient.get} asks the API to hold a read: the
 * API's own maximum. This client sets no request timeout of its own; a
 * `fetch` or proxy that does must outlast it.
 */
export const MAX_COMMAND_WAIT_SECONDS = 60;

/**
 * `tasks.commands`: `exec`, `upload` and `download` against an eval task's
 * live sandbox.
 *
 * A command is a row the task's workflow executes and stamps: `create`
 * returns it `queued`, and `get` reads its outcome, optionally holding the
 * read until it finishes. Eval tasks only (created with `kind: "eval"` and
 * `commands: true`), behind `tasks:exec` (an org admin or owner, or the
 * `operator` role), on a plane with evals enabled.
 */
export class TaskCommandsClient {
  constructor(private readonly http: ResourceHttpClient) {}

  /** Record a command and send it to the task's workflow. */
  create(taskId: string, spec: TaskCommandSpec): Promise<TaskCommand> {
    return this.http.request<TaskCommand>({
      method: "POST",
      path: `/v1/tasks/${encodeURIComponent(taskId)}/commands`,
      body: spec,
    });
  }

  /** List a task's commands, newest first. */
  list(taskId: string, params?: TaskCommandListParams): Paginator<TaskCommand> {
    return paginateGet<TaskCommand>(
      this.http,
      `/v1/tasks/${encodeURIComponent(taskId)}/commands`,
      params,
      params?.next,
    );
  }

  /**
   * Read a command. `wait_seconds` holds the read until it finishes, capped
   * at {@link MAX_COMMAND_WAIT_SECONDS}.
   */
  get(
    taskId: string,
    commandId: string,
    options: TaskCommandGetOptions = {},
  ): Promise<TaskCommand> {
    const wait = options.wait_seconds;
    return this.http.request<TaskCommand>({
      method: "GET",
      path: `/v1/tasks/${encodeURIComponent(taskId)}/commands/${encodeURIComponent(commandId)}`,
      query:
        wait === undefined
          ? undefined
          : {
              wait_seconds: Math.min(
                Math.max(wait, 0),
                MAX_COMMAND_WAIT_SECONDS,
              ),
            },
    });
  }
}

export class TasksClient<
  TCreate extends object = TaskCreateParams,
  TStart extends TCreate & { prompt: string } = TCreate & { prompt: string },
> {
  readonly runs: TaskRunsClient;
  /** Eval sandbox operations; see {@link TaskCommandsClient}. */
  readonly commands: TaskCommandsClient;
  private readonly mapTaskBody: TaskBodyMapper<TCreate>;

  constructor(
    private readonly http: ResourceHttpClient,
    mapTaskBody: TaskBodyMapper<TCreate> = identityTaskBody,
  ) {
    this.runs = new TaskRunsClient(http);
    this.commands = new TaskCommandsClient(http);
    this.mapTaskBody = mapTaskBody;
  }

  /**
   * List tasks matching `params`. `await` the result for the first page,
   * or `for await` it to stream every task across pages (fetched lazily —
   * `limit` sets the page size, `next` the starting cursor; stop early to
   * stop fetching).
   */
  list(params?: TaskListParams): Paginator<Task> {
    return paginateGet<Task>(this.http, "/v1/tasks", params, params?.next);
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

  /** Cursor-style sugar: create a task + return a handle on its initial run. */
  async start(params: TStart): Promise<RunHandle> {
    const res = await this.create(params);
    return new RunHandle(res.task, res.run, this.runs);
  }
}

export {
  TasksClient as TasksApi,
  TaskRunsClient as TaskRunsApi,
  TaskCommandsClient as TaskCommandsApi,
};
