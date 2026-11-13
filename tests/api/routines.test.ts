import { describe, expect, it, vi } from "vitest";
import {
  RoutinesApi,
  HttpClient,
  IntrospectionClient,
} from "@introspection-sdk/introspection-node";
import type {
  Routine,
  RoutineMetadata,
} from "@introspection-sdk/introspection-node";

function mockHttp(overrides: Record<string, unknown> = {}) {
  return {
    request: vi.fn().mockResolvedValue(overrides.requestResult ?? {}),
  } as unknown as HttpClient;
}

function calls(http: HttpClient) {
  return (http.request as ReturnType<typeof vi.fn>).mock.calls.map(
    (call) => call[0],
  );
}

const ROUTINE_ID = "0199a1b2-0000-7000-8000-000000000001";
const TASK_ID = "0199a1b2-0000-7000-8000-0000000000ee";
const RUNTIME_GROUP_ID = "0199a1b2-0000-7000-8000-0000000000dd";

const ROUTINE_FIXTURE: Routine & { agent_member_id: null } = {
  id: ROUTINE_ID,
  org_id: "0199a1b2-0000-7000-8000-0000000000aa",
  project_id: "0199a1b2-0000-7000-8000-0000000000bb",
  name: "Weekly digest",
  description: "Summarize the week",
  enabled: true,
  // Still on the wire until introspection-cloud#3154 drops it.
  agent_member_id: null,
  runtime_group_id: RUNTIME_GROUP_ID,
  task_id: TASK_ID,
  created_by_member_id: "0199a1b2-0000-7000-8000-0000000000cc",
  execution_blocked_reason: null,
  can_manage: true,
  tags: ["digest"],
  trigger_type: "cron",
  cron_schedule: "0 9 * * 1",
  kind: null,
  prompt: "Summarize my week",
  metadata: {
    cron_schedules: ["0 9 * * 1", "0 17 * * 5"],
    timezone: "Europe/London",
    repositories: [{ repo: "acme/app", ref: "main" }],
    conditions: [
      { type: "has_new_tasks_since_last_run" },
      { type: "brand_new_condition" },
    ],
  },
  last_triggered_at: "2026-09-28T09:00:00Z",
  next_trigger_at: "2026-10-05T09:00:00.123456Z",
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-28T09:00:01Z",
  owner_role: "operator",
};

function page(records: unknown[], next: string | null = null) {
  return { records, count: records.length, total_count: records.length, next };
}

describe("RoutinesApi", () => {
  it("list() encodes every filter and reads the routine shape", async () => {
    const http = mockHttp({ requestResult: page([ROUTINE_FIXTURE]) });
    const first = await new RoutinesApi(http).list({
      limit: 1,
      kind: "observation_synthesis",
      enabled: true,
      scheduled: false,
      task_id: TASK_ID,
    });

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/routines",
      query: {
        limit: 1,
        kind: "observation_synthesis",
        enabled: true,
        scheduled: false,
        task_id: TASK_ID,
        next: undefined,
      },
      schema: "Paginated<Routine>",
    });
    const routine = first.records[0];
    expect(routine.kind).toBeNull();
    expect(routine.can_manage).toBe(true);
    expect(routine.runtime_group_id).toBe(RUNTIME_GROUP_ID);
    expect(routine.task_id).toBe(TASK_ID);
    expect(routine.owner_role).toBe("operator");
    expect(routine.metadata?.timezone).toBe("Europe/London");
    expect(routine.metadata?.conditions?.map((c) => c.type)).toEqual([
      "has_new_tasks_since_last_run",
      "brand_new_condition",
    ]);
  });

  it("list() carries task_id across pages and starts from a given cursor", async () => {
    const http = {
      request: vi
        .fn()
        .mockResolvedValueOnce(page([ROUTINE_FIXTURE], "cur-2"))
        .mockResolvedValueOnce(
          page([{ ...ROUTINE_FIXTURE, id: "b", name: "second" }]),
        ),
    } as unknown as HttpClient;
    const names: string[] = [];
    for await (const routine of new RoutinesApi(http).list({
      task_id: TASK_ID,
      next: "cur-1",
    })) {
      names.push(routine.name);
    }

    expect(names).toEqual(["Weekly digest", "second"]);
    expect(calls(http).map((call) => call.query)).toEqual([
      { task_id: TASK_ID, next: "cur-1" },
      { task_id: TASK_ID, next: "cur-2" },
    ]);
  });

  it("list() surfaces project_check_in and a kind this SDK predates", async () => {
    const http = mockHttp({
      requestResult: page([
        {
          ...ROUTINE_FIXTURE,
          id: "a",
          kind: "project_check_in",
          task_id: null,
        },
        {
          ...ROUTINE_FIXTURE,
          id: "b",
          kind: "not_yet_invented",
          owner_role: null,
        },
      ]),
    });
    const first = await new RoutinesApi(http).list({
      kind: "project_check_in",
    });

    expect(calls(http)[0].query).toEqual({
      kind: "project_check_in",
      next: undefined,
    });
    expect(first.records.map((a) => a.kind)).toEqual([
      "project_check_in",
      "not_yet_invented",
    ]);
    expect(first.records[1].owner_role).toBeNull();
  });

  it("create() POSTs only the fields that are set", async () => {
    const http = mockHttp({ requestResult: ROUTINE_FIXTURE });
    const metadata: RoutineMetadata = {
      cron_schedules: ["0 9 * * 1"],
      timezone: "UTC",
    };
    const created = await new RoutinesApi(http).create({
      name: "Weekly digest",
      trigger_type: "cron",
      cron_schedule: "0 9 * * 1",
      prompt: "Summarize my week",
      runtime_group_id: RUNTIME_GROUP_ID,
      description: undefined,
      metadata,
    });

    expect(created.name).toBe("Weekly digest");
    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/routines",
      body: {
        name: "Weekly digest",
        trigger_type: "cron",
        cron_schedule: "0 9 * * 1",
        prompt: "Summarize my week",
        runtime_group_id: RUNTIME_GROUP_ID,
        metadata: { cron_schedules: ["0 9 * * 1"], timezone: "UTC" },
      },
      schema: "Routine",
    });
  });

  it("create() sends a one-off reminder into an existing task", async () => {
    const http = mockHttp({ requestResult: ROUTINE_FIXTURE });
    await new RoutinesApi(http).create({
      name: "Friday check-in",
      trigger_type: "manual",
      prompt: "How did the week go?",
      runtime_group_id: RUNTIME_GROUP_ID,
      task_id: TASK_ID,
      next_trigger_at: "2026-10-10T09:00:00Z",
      enabled: false,
    });

    expect(calls(http)[0].body).toEqual({
      name: "Friday check-in",
      trigger_type: "manual",
      prompt: "How did the week go?",
      runtime_group_id: RUNTIME_GROUP_ID,
      task_id: TASK_ID,
      next_trigger_at: "2026-10-10T09:00:00Z",
      enabled: false,
    });
  });

  it("create() sends a platform kind", async () => {
    const http = mockHttp({ requestResult: ROUTINE_FIXTURE });
    await new RoutinesApi(http).create({
      name: "Check-in",
      trigger_type: "cron",
      cron_schedule: "0 9 * * *",
      kind: "project_check_in",
      prompt: "Check in",
      runtime_group_id: RUNTIME_GROUP_ID,
    });

    expect(calls(http)[0].body).toMatchObject({ kind: "project_check_in" });
  });

  it("get() reads one routine", async () => {
    const http = mockHttp({ requestResult: ROUTINE_FIXTURE });
    const routine = await new RoutinesApi(http).get(ROUTINE_ID);

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: `/v1/routines/${ROUTINE_ID}`,
      schema: "Routine",
    });
    expect(routine.next_trigger_at).toBe("2026-10-05T09:00:00.123456Z");
  });

  it("update() PATCHes only the fields that are set", async () => {
    const http = mockHttp({ requestResult: ROUTINE_FIXTURE });
    await new RoutinesApi(http).update(ROUTINE_ID, {
      enabled: false,
      name: undefined,
      next_trigger_at: undefined,
    });

    expect(http.request).toHaveBeenCalledWith({
      method: "PATCH",
      path: `/v1/routines/${ROUTINE_ID}`,
      body: { enabled: false },
      schema: "Routine",
    });
  });

  it("update() sends task, slot and metadata changes", async () => {
    const http = mockHttp({ requestResult: ROUTINE_FIXTURE });
    await new RoutinesApi(http).update(ROUTINE_ID, {
      task_id: TASK_ID,
      next_trigger_at: "2026-10-12T09:00:00Z",
      metadata: { timezone: "Australia/Sydney" },
    });

    expect(calls(http)[0].body).toEqual({
      task_id: TASK_ID,
      next_trigger_at: "2026-10-12T09:00:00Z",
      metadata: { timezone: "Australia/Sydney" },
    });
  });

  it("update() with nothing set sends an empty body", async () => {
    const http = mockHttp({ requestResult: ROUTINE_FIXTURE });
    await new RoutinesApi(http).update(ROUTINE_ID, {});

    expect(calls(http)[0].body).toEqual({});
  });

  it("delete() soft-deletes and expects an empty response", async () => {
    const http = mockHttp({ requestResult: undefined });
    await new RoutinesApi(http).delete(ROUTINE_ID);

    expect(http.request).toHaveBeenCalledWith({
      method: "DELETE",
      path: `/v1/routines/${ROUTINE_ID}`,
      expect: "empty",
    });
  });

  it("trigger() runs one now and returns the task", async () => {
    const http = mockHttp({
      requestResult: {
        status: "triggered",
        routine_id: ROUTINE_ID,
        task_id: TASK_ID,
        reason: null,
      },
    });
    const result = await new RoutinesApi(http).trigger(ROUTINE_ID);

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: `/v1/routines/${ROUTINE_ID}/trigger`,
      schema: "RoutineTriggerResponse",
    });
    expect(result.status).toBe("triggered");
    expect(result.task_id).toBe(TASK_ID);
  });

  it("trigger() surfaces a skip with its reason", async () => {
    const http = mockHttp({
      requestResult: {
        status: "skipped",
        routine_id: ROUTINE_ID,
        task_id: null,
        reason: "conditions_not_met",
      },
    });
    const result = await new RoutinesApi(http).trigger(ROUTINE_ID);

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("conditions_not_met");
  });

  it("percent-encodes the id", async () => {
    const http = mockHttp({ requestResult: ROUTINE_FIXTURE });
    await new RoutinesApi(http).get("a/b");

    expect(calls(http)[0].path).toBe("/v1/routines/a%2Fb");
  });
});

describe("client.routines", () => {
  function client(responses: unknown[]) {
    const requests: { url: URL; method: string; body: unknown }[] = [];
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({
          url: new URL(String(input)),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        const next = responses.shift();
        return next === undefined
          ? new Response(null, { status: 204 })
          : new Response(JSON.stringify(next), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
      },
    );
    const sdk = new IntrospectionClient({
      token: "intro_test",
      advanced: {
        baseApiUrl: "https://cp.test",
        dpUrl: "https://dp.test",
        fetch: fetch as unknown as typeof globalThis.fetch,
      },
    });
    return { sdk, requests };
  }

  it("lists on the Data Plane with task_id kept on every page", async () => {
    const { sdk, requests } = client([
      page([ROUTINE_FIXTURE], "cur-2"),
      page([{ ...ROUTINE_FIXTURE, id: "b" }]),
    ]);

    const ids: string[] = [];
    for await (const routine of sdk.routines.list({
      task_id: TASK_ID,
      enabled: true,
    })) {
      ids.push(routine.id);
    }

    expect(ids).toEqual([ROUTINE_ID, "b"]);
    expect(requests.map((r) => r.url.origin)).toEqual([
      "https://dp.test",
      "https://dp.test",
    ]);
    expect(requests[0].url.pathname).toBe("/v1/routines");
    expect(Object.fromEntries(requests[0].url.searchParams)).toEqual({
      task_id: TASK_ID,
      enabled: "true",
    });
    expect(Object.fromEntries(requests[1].url.searchParams)).toEqual({
      task_id: TASK_ID,
      enabled: "true",
      next: "cur-2",
    });
    await sdk.shutdown();
  });

  it("serializes a PATCH with only the set fields and deletes with a 204", async () => {
    const { sdk, requests } = client([ROUTINE_FIXTURE]);

    await sdk.routines.update(ROUTINE_ID, {
      prompt: "New prompt",
      description: undefined,
    });
    await sdk.routines.delete(ROUTINE_ID);

    expect(requests[0].method).toBe("PATCH");
    expect(requests[0].body).toEqual({ prompt: "New prompt" });
    expect(requests[1].method).toBe("DELETE");
    expect(requests[1].url.pathname).toBe(`/v1/routines/${ROUTINE_ID}`);
    await sdk.shutdown();
  });
});
