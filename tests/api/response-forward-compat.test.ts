/**
 * Forward compatibility: with strict decoding off (the default), a response
 * holding a field or an enum value newer than this SDK decodes, through the
 * real client, resource and stream code.
 *
 * A fake `fetch` stands in for the server, so no network boundary is crossed
 * (AGENTS.md §6 case 1, as in `strict-schema.test.ts`): the payloads carry
 * fields and values no server sends yet, which a recording cannot hold.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AnnotationsApi,
  EventType,
  HttpClient,
  RunHandle,
  TasksApi,
  type AGUIEvent,
  type TaskRun,
} from "@introspection-sdk/introspection-node";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(events: unknown[]): Response {
  const text = events
    .map((event) => `event: ag_ui\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
  return new Response(text, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function client(respond: () => Response): HttpClient {
  return new HttpClient({
    apiUrl: "https://api.example.com",
    token: "test-token",
    fetch: (() => Promise.resolve(respond())) as typeof fetch,
    maxRetries: 0,
  });
}

const ANNOTATION = {
  trace_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  span_id: "bbbbbbbbbbbbbbbb",
  conversation_id: "conversation-1",
  labels: ["good-structure"],
  assignee_member_ids: [],
  annotator_member_ids: [],
  has_comment: false,
  comment_count: 0,
  updated_at: "2026-08-25T01:02:03Z",
};

const TASK = {
  id: "task-1",
  org_id: "org-1",
  project_id: "proj-1",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  kind: "workflow",
  status: "hibernating",
  is_archived: false,
  agent: { sandbox_status: "warm", session_id: "s1", region_hint: "eu" },
  priority_v2: { level: 3 },
};

const RUN = { id: "run-1", task_id: "task-1", status: "running" } as TaskRun;

beforeEach(() => {
  vi.stubEnv("INTROSPECTION_STRICT_SCHEMA", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("responses newer than the SDK (strict decoding off)", () => {
  it("decodes an annotation page with unknown top-level and nested fields", async () => {
    const page = {
      records: [
        {
          ...ANNOTATION,
          status: "escalated",
          reviewer: { id: "m1", novel: true },
        },
      ],
      count: 1,
      total_count: null,
      next: null,
      cursor_v2: { token: "x" },
    };
    const http = client(() => jsonResponse(page));
    const annotations = new AnnotationsApi(http, http);
    const first = await annotations.list();
    expect(first.records).toHaveLength(1);
    expect(first.records[0]).toMatchObject({
      span_id: ANNOTATION.span_id,
      status: "escalated",
      reviewer: { novel: true },
    });
  });

  it("decodes a task with an unknown status, kind and fields", async () => {
    const tasks = new TasksApi(client(() => jsonResponse(TASK)));
    const task = await tasks.get("task-1");
    expect(task.status).toBe("hibernating");
    expect(task.kind).toBe("workflow");
    expect(task.agent).toMatchObject({ region_hint: "eu" });
  });

  it("streams past AG-UI events, roles and keys the SDK does not know", async () => {
    const events = [
      { type: EventType.RUN_STARTED, threadId: "t", runId: "run-1" },
      { type: "BRAND_NEW_EVENT", payload: { x: 1 } },
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "m1",
        delta: "Hello",
        novel: { a: 1 },
      },
      {
        type: EventType.MESSAGES_SNAPSHOT,
        messages: [
          { id: "m0", role: "critic", content: "a role from the future" },
          { id: "m1", role: "assistant", content: "Hello", novel: 1 },
        ],
      },
      {
        type: EventType.RUN_FINISHED,
        threadId: "t",
        runId: "run-1",
        outcome: { type: "success", novel: 1 },
      },
    ];
    const tasks = new TasksApi(client(() => sseResponse(events)));
    const seen: AGUIEvent[] = [];
    for await (const event of tasks.runs.stream("task-1", "run-1")) {
      seen.push(event);
    }
    expect(seen.map((event) => event.type)).toEqual([
      EventType.RUN_STARTED,
      "BRAND_NEW_EVENT",
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.MESSAGES_SNAPSHOT,
      EventType.RUN_FINISHED,
    ]);

    const handle = new RunHandle(
      null,
      RUN,
      new TasksApi(client(() => sseResponse(events))).runs,
    );
    await expect(handle.text()).resolves.toBe("Hello");
  });

  it("still fails a known event that is malformed", async () => {
    const tasks = new TasksApi(
      client(() =>
        sseResponse([
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m1", delta: 5 },
        ]),
      ),
    );
    const read = async () => {
      for await (const event of tasks.runs.stream("task-1", "run-1")) {
        void event;
      }
    };
    await expect(read()).rejects.toThrow(/delta/);
  });
});
