import { describe, expect, it, vi } from "vitest";
import {
  EventType,
  HttpClient,
  TasksApi,
  TaskRunsApi,
  RunHandle,
} from "@introspection-sdk/introspection-node";

function mockHttp(overrides: Record<string, unknown> = {}) {
  return {
    request: vi.fn().mockResolvedValue(overrides.requestResult ?? {}),
    stream: vi.fn().mockResolvedValue(overrides.streamResult ?? new Response()),
  } as unknown as HttpClient;
}

const TASK_FIXTURE = {
  id: "task-1",
  org_id: "org-1",
  project_id: "proj-1",
  created_at: "2025-01-01T00:00:00Z",
  updated_at: "2025-01-01T00:00:00Z",
  mode: "agent" as const,
  status: "running" as const,
  is_archived: false,
};

const RUN_FIXTURE = {
  id: "run-1",
  task_id: "task-1",
  status: "running" as const,
};

describe("TasksApi", () => {
  it("list() calls GET /v1/tasks", async () => {
    const http = mockHttp({
      requestResult: {
        records: [TASK_FIXTURE],
        count: 1,
        total_count: 1,
        next: null,
      },
    });
    const api = new TasksApi(http);
    const tasks = [];
    for await (const t of api.list({ limit: 10 })) tasks.push(t);

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/tasks",
      query: { limit: 10 },
    });
    expect(tasks).toHaveLength(1);
  });

  it("list() paginates through all pages", async () => {
    const page1 = {
      records: [TASK_FIXTURE],
      count: 1,
      total_count: 2,
      next: "cursor-2",
    };
    const page2 = {
      records: [{ ...TASK_FIXTURE, id: "task-2" }],
      count: 1,
      total_count: 2,
      next: null,
    };
    const http = mockHttp();
    (http.request as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);

    const api = new TasksApi(http);
    const tasks = [];
    for await (const t of api.list()) tasks.push(t);

    expect(tasks).toHaveLength(2);
    expect(tasks[0].id).toBe("task-1");
    expect(tasks[1].id).toBe("task-2");
    expect(http.request).toHaveBeenCalledTimes(2);
    expect(
      (http.request as ReturnType<typeof vi.fn>).mock.calls[1][0].query.next,
    ).toBe("cursor-2");
  });

  it("create() calls POST /v1/tasks", async () => {
    const http = mockHttp({
      requestResult: { task: TASK_FIXTURE, run: RUN_FIXTURE },
    });
    const api = new TasksApi(http);
    await api.create({ title: "Test task" });

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/tasks",
      body: { title: "Test task" },
    });
  });

  it("create() with fork_share_id includes it in the POST /v1/tasks body", async () => {
    const http = mockHttp({
      requestResult: { task: TASK_FIXTURE, run: RUN_FIXTURE },
    });
    const api = new TasksApi(http);
    await api.create({ title: "Forked task", fork_share_id: "share-1" });

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/tasks",
      body: { title: "Forked task", fork_share_id: "share-1" },
    });
  });

  it("list() forwards the identity_key filter", async () => {
    const http = mockHttp({
      requestResult: { records: [], count: 0, total_count: 0, next: null },
    });
    const api = new TasksApi(http);
    await api.list({ identity_key: "user:u_a" });

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/tasks",
      query: { identity_key: "user:u_a" },
    });
  });

  it("get() calls GET /v1/tasks/:id", async () => {
    const http = mockHttp({ requestResult: TASK_FIXTURE });
    const api = new TasksApi(http);
    await api.get("task-1");

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/tasks/task-1",
    });
  });

  it("update() calls PATCH /v1/tasks/:id", async () => {
    const http = mockHttp({ requestResult: TASK_FIXTURE });
    const api = new TasksApi(http);
    await api.update("task-1", { title: "Updated" });

    expect(http.request).toHaveBeenCalledWith({
      method: "PATCH",
      path: "/v1/tasks/task-1",
      body: { title: "Updated" },
    });
  });

  it("delete() calls DELETE /v1/tasks/:id", async () => {
    const http = mockHttp();
    const api = new TasksApi(http);
    await api.delete("task-1");

    expect(http.request).toHaveBeenCalledWith({
      method: "DELETE",
      path: "/v1/tasks/task-1",
      expect: "empty",
    });
  });

  it("archive() calls POST /v1/tasks/:id/archive", async () => {
    const http = mockHttp();
    const api = new TasksApi(http);
    await api.archive("task-1");

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/tasks/task-1/archive",
      expect: "empty",
    });
  });

  it("unarchive() calls POST /v1/tasks/:id/unarchive", async () => {
    const http = mockHttp();
    const api = new TasksApi(http);
    await api.unarchive("task-1");

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/tasks/task-1/unarchive",
      expect: "empty",
    });
  });

  it("start() creates a task and returns a RunHandle", async () => {
    const http = mockHttp({
      requestResult: { task: TASK_FIXTURE, run: RUN_FIXTURE },
    });
    const api = new TasksApi(http);
    const handle = await api.start({ title: "Quick", prompt: "Do something" });

    expect(handle).toBeInstanceOf(RunHandle);
    expect(handle.task).toEqual(TASK_FIXTURE);
    expect(handle.run).toEqual(RUN_FIXTURE);
  });

  it("URL-encodes task IDs with special characters", async () => {
    const http = mockHttp({ requestResult: TASK_FIXTURE });
    const api = new TasksApi(http);
    await api.get("task/with spaces");

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/tasks/task%2Fwith%20spaces",
    });
  });
});

describe("TaskRunsApi", () => {
  it("create() calls POST /v1/tasks/:id/runs", async () => {
    const http = mockHttp({ requestResult: { run: RUN_FIXTURE } });
    const runs = new TaskRunsApi(http);
    const handle = await runs.create("task-1", { message: "hello" });

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/tasks/task-1/runs",
      body: { message: "hello" },
    });
    expect(handle).toBeInstanceOf(RunHandle);
    expect(handle.task).toBeNull();
  });

  it("resume() posts AG-UI resume entries to POST /v1/tasks/:id/runs", async () => {
    const http = mockHttp({ requestResult: { run: RUN_FIXTURE } });
    const runs = new TaskRunsApi(http);
    const handle = await runs.resume("task-1", {
      resume: [{ interruptId: "plan:tool-1", status: "cancelled" }],
    });

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/tasks/task-1/runs",
      body: {
        resume: [{ interruptId: "plan:tool-1", status: "cancelled" }],
      },
    });
    expect(handle).toBeInstanceOf(RunHandle);
    expect(handle.task).toBeNull();
  });

  it("get() calls GET /v1/tasks/:id/runs/:runId", async () => {
    const http = mockHttp({ requestResult: RUN_FIXTURE });
    const runs = new TaskRunsApi(http);
    await runs.get("task-1", "run-1");

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/tasks/task-1/runs/run-1",
    });
  });

  it("cancel() calls POST /v1/tasks/:id/runs/:runId/cancel", async () => {
    const http = mockHttp({ requestResult: { id: "run-1" } });
    const runs = new TaskRunsApi(http);
    await runs.cancel("task-1", "run-1");

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/tasks/task-1/runs/run-1/cancel",
    });
  });

  it("abort() calls POST /v1/tasks/:id/runs/:runId/abort", async () => {
    const http = mockHttp({ requestResult: { id: "run-1" } });
    const runs = new TaskRunsApi(http);
    await runs.abort("task-1", "run-1");

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/tasks/task-1/runs/run-1/abort",
    });
  });
});

describe("RunHandle", () => {
  it("text() collects AG-UI text deltas", async () => {
    const encoder = new TextEncoder();
    const streamPayload = [
      `event: ag_ui\ndata: ${JSON.stringify({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-1",
        delta: "Hello ",
      })}\n\n`,
      `event: ag_ui\ndata: ${JSON.stringify({
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-1",
        delta: "world",
      })}\n\n`,
    ].join("");
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(streamPayload));
        controller.close();
      },
    });
    const streamResponse = new Response(stream);

    const http = mockHttp({ streamResult: streamResponse });
    const runs = new TaskRunsApi(http);
    const handle = new RunHandle(null, RUN_FIXTURE, runs);

    const result = await handle.text();
    expect(result).toBe("Hello world");
  });

  it("cancel() delegates to runs.cancel()", async () => {
    const http = mockHttp({ requestResult: { id: "run-1" } });
    const runs = new TaskRunsApi(http);
    const handle = new RunHandle(TASK_FIXTURE, RUN_FIXTURE, runs);
    await handle.cancel();

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/tasks/task-1/runs/run-1/cancel",
    });
  });

  it("abort() delegates to runs.abort()", async () => {
    const http = mockHttp({ requestResult: { id: "run-1" } });
    const runs = new TaskRunsApi(http);
    const handle = new RunHandle(TASK_FIXTURE, RUN_FIXTURE, runs);
    await handle.abort();

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/tasks/task-1/runs/run-1/abort",
    });
  });
});
