import type {
  Paginated,
  SseEvent,
  Task,
  TaskCancelResponse,
  TaskCreateParams,
  TaskCreateResponse,
  TaskListParams,
  TaskRun,
  TaskRunCreateParams,
  TaskRunResponse,
  TaskUpdateParams,
} from "@introspection-sdk/types";
import { HttpClient } from "../http.js";
import { parseSse } from "../streaming.js";

export interface StartParams extends TaskCreateParams {
  prompt: string; // required for the cursor-style sugar
}

export class RunHandle {
  constructor(
    public readonly task: Task | null,
    public readonly run: TaskRun,
    private readonly runs: TaskRunsApi,
  ) {}

  stream(): AsyncIterable<SseEvent> {
    return this.runs.stream(this.run.task_id, this.run.id);
  }

  cancel(): Promise<TaskCancelResponse> {
    return this.runs.cancel(this.run.task_id, this.run.id);
  }

  /** Convenience: collect `data` from `event: text`-style frames into a string. */
  async text(): Promise<string> {
    let out = "";
    for await (const ev of this.stream()) {
      if (ev.event === "text" || ev.event === "message") out += ev.data;
    }
    return out;
  }
}

export class TaskRunsApi {
  constructor(private readonly http: HttpClient) {}

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

export class TasksApi {
  readonly runs: TaskRunsApi;

  constructor(private readonly http: HttpClient) {
    this.runs = new TaskRunsApi(http);
  }

  list(params?: TaskListParams): Promise<Paginated<Task>> {
    return this.http.request<Paginated<Task>>({
      method: "GET",
      path: "/v1/tasks",
      query: params as Record<string, unknown> | undefined,
    });
  }

  async *listAll(params?: TaskListParams): AsyncIterable<Task> {
    let next: string | undefined = params?.next;
    do {
      const page = await this.list({ ...params, next });
      for (const t of page.records) yield t;
      next = page.next ?? undefined;
    } while (next);
  }

  create(body: TaskCreateParams): Promise<TaskCreateResponse> {
    return this.http.request<TaskCreateResponse>({
      method: "POST",
      path: "/v1/tasks",
      body,
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
  async start(params: StartParams): Promise<RunHandle> {
    const res = await this.create(params);
    return new RunHandle(res.task, res.run, this.runs);
  }
}
