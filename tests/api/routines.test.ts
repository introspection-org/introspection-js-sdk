import { describe, expect, it, vi } from "vitest";
import {
  RoutinesApi,
  HttpClient,
  IntrospectionClient,
} from "@introspection-sdk/introspection-node";
import {
  isKnownRoutineTrigger,
  type Routine,
  type RoutineTaskMetadata,
  type RoutineTrigger,
  type RoutineTriggerSpec,
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
const TRIGGER_ID = "0199a1b2-0000-7000-8000-0000000000ff";

const WEBHOOK_TRIGGER: RoutineTriggerSpec = {
  type: "webhook",
  connector_slug: "ci-alerts",
  event_types: ["build.failed"],
  payload_fields: { branch: ["main"] },
};

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
  kind: null,
  prompt: "Summarize my week",
  repositories: [{ repo: "acme/app", ref: "main" }],
  conditions: [
    { type: "has_new_tasks_since_last_run" },
    { type: "brand_new_condition" },
  ],
  synthesis: null,
  last_triggered_at: "2026-09-28T09:00:00Z",
  next_trigger_at: "2026-10-05T09:00:00.123456Z",
  created_at: "2026-09-01T10:00:00Z",
  updated_at: "2026-09-28T09:00:01Z",
  owner_role: "operator",
  triggers: [
    {
      id: "0199a1b2-0000-7000-8000-000000000101",
      type: "schedule",
      cron: "0 9 * * 1",
      timezone: "Europe/London",
    },
    {
      id: "0199a1b2-0000-7000-8000-000000000102",
      type: "schedule",
      cron: "0 17 * * 5",
    },
    {
      id: TRIGGER_ID,
      type: "webhook",
      connector_slug: "ci-alerts",
      event_types: ["build.failed"],
      payload_fields: { branch: ["main"] },
    },
  ],
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
    expect(routine.repositories).toEqual([{ repo: "acme/app", ref: "main" }]);
    expect(routine.conditions.map((c) => c.type)).toEqual([
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
    const created = await new RoutinesApi(http).create({
      name: "Weekly digest",
      prompt: "Summarize my week",
      runtime_group_id: RUNTIME_GROUP_ID,
      description: undefined,
      synthesis: undefined,
      repositories: [{ repo: "acme/app" }],
      conditions: [{ type: "has_new_tasks_since_last_run" }],
      triggers: [{ type: "schedule", cron: "0 9 * * 1", timezone: "UTC" }],
    });

    expect(created.name).toBe("Weekly digest");
    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/routines",
      body: {
        name: "Weekly digest",
        prompt: "Summarize my week",
        runtime_group_id: RUNTIME_GROUP_ID,
        repositories: [{ repo: "acme/app" }],
        conditions: [{ type: "has_new_tasks_since_last_run" }],
        triggers: [{ type: "schedule", cron: "0 9 * * 1", timezone: "UTC" }],
      },
      schema: "Routine",
    });
  });

  it("create() sends a one-off reminder into an existing task", async () => {
    const http = mockHttp({ requestResult: ROUTINE_FIXTURE });
    await new RoutinesApi(http).create({
      name: "Friday check-in",
      prompt: "How did the week go?",
      runtime_group_id: RUNTIME_GROUP_ID,
      task_id: TASK_ID,
      next_trigger_at: "2026-10-10T09:00:00Z",
      enabled: false,
    });

    expect(calls(http)[0].body).toEqual({
      name: "Friday check-in",
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
      triggers: [{ type: "schedule", cron: "0 9 * * *" }],
      kind: "project_check_in",
      prompt: "Check in",
      runtime_group_id: RUNTIME_GROUP_ID,
    });

    expect(calls(http)[0].body).toMatchObject({ kind: "project_check_in" });
  });

  it("create() sends every trigger type", async () => {
    const http = mockHttp({ requestResult: ROUTINE_FIXTURE });
    const triggers: RoutineTriggerSpec[] = [
      { type: "schedule", cron: "0 9 * * 1-5", timezone: "Australia/Sydney" },
      {
        type: "slack",
        event_types: ["slack.reaction.added"],
        channel_ids: ["C1"],
        emoji: ["eyes"],
      },
      {
        type: "github",
        event_types: ["github.pull_request.opened"],
        repository_ids: ["123"],
        branches: ["main"],
      },
      {
        type: "linear",
        event_types: ["linear.issue.created"],
        to_states: ["Todo"],
      },
      WEBHOOK_TRIGGER,
    ];
    await new RoutinesApi(http).create({
      name: "Triage failed builds",
      prompt: "Triage the failed build at @parameters.build_url.",
      runtime_group_id: RUNTIME_GROUP_ID,
      triggers,
    });

    expect(calls(http)[0].body.triggers).toEqual(triggers);
  });

  it("reads each trigger variant by type, with unset filter keys absent", async () => {
    const http = mockHttp({ requestResult: ROUTINE_FIXTURE });
    const routine = await new RoutinesApi(http).get(ROUTINE_ID);

    const [weekday, friday, webhook] = routine.triggers;
    expect(weekday).toMatchObject({ type: "schedule", cron: "0 9 * * 1" });
    expect(friday).not.toHaveProperty("timezone");
    expect(webhook.id).toBe(TRIGGER_ID);
    expect(webhook).not.toHaveProperty("filter");
    if (!isKnownRoutineTrigger(webhook) || webhook.type !== "webhook") {
      throw new Error("expected a webhook trigger");
    }
    expect(webhook.payload_fields).toEqual({ branch: ["main"] });
  });

  it("decodes a trigger type this SDK predates and keeps it on update", async () => {
    const jira: RoutineTrigger = {
      id: "0199a1b2-0000-7000-8000-000000000103",
      type: "jira",
      event_types: ["jira.issue.created"],
      project_keys: ["ENG"],
    };
    const http = mockHttp({
      requestResult: { ...ROUTINE_FIXTURE, triggers: [jira] },
    });
    const routines = new RoutinesApi(http);
    const routine = await routines.get(ROUTINE_ID);

    const [trigger] = routine.triggers;
    expect(isKnownRoutineTrigger(trigger)).toBe(false);
    expect(trigger).toEqual(jira);

    await routines.update(ROUTINE_ID, {
      triggers: [...routine.triggers, WEBHOOK_TRIGGER],
    });
    expect(calls(http)[1].body).toEqual({
      triggers: [jira, WEBHOOK_TRIGGER],
    });
  });

  it("update() replaces the trigger list, keeping listed ids", async () => {
    const http = mockHttp({ requestResult: ROUTINE_FIXTURE });
    await new RoutinesApi(http).update(ROUTINE_ID, {
      triggers: [{ ...WEBHOOK_TRIGGER, id: TRIGGER_ID }],
    });
    await new RoutinesApi(http).update(ROUTINE_ID, { triggers: [] });

    expect(calls(http).map((call) => call.body)).toEqual([
      { triggers: [{ ...WEBHOOK_TRIGGER, id: TRIGGER_ID }] },
      { triggers: [] },
    ]);
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

  it("update() sends task, slot, conditions and synthesis changes", async () => {
    const http = mockHttp({ requestResult: ROUTINE_FIXTURE });
    await new RoutinesApi(http).update(ROUTINE_ID, {
      task_id: TASK_ID,
      next_trigger_at: "2026-10-12T09:00:00Z",
      conditions: [],
      synthesis: { batch: false, max_conversations: 50 },
    });

    expect(calls(http)[0].body).toEqual({
      task_id: TASK_ID,
      next_trigger_at: "2026-10-12T09:00:00Z",
      conditions: [],
      synthesis: { batch: false, max_conversations: 50 },
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

  describe("trigger() with parameters", () => {
    const UPLOADED_ID = "0199a1b2-0000-7000-8000-0000000000f1";
    const EXTRA_FILE = {
      id: "0199a1b2-0000-7000-8000-0000000000f2",
      name: "contract.pdf",
    };
    const TRIGGERED = {
      status: "triggered",
      routine_id: ROUTINE_ID,
      task_id: TASK_ID,
      run_id: null,
      reason: null,
      result: null,
    };
    const PROMPT_ROUTINE = { ...ROUTINE_FIXTURE, task_id: null };
    const PLATFORM_ROUTINE = {
      ...ROUTINE_FIXTURE,
      kind: "observation_synthesis",
      task_id: null,
      runtime_group_id: null,
    };
    const READ = {
      method: "GET",
      path: `/v1/routines/${ROUTINE_ID}`,
      schema: "Routine",
    };
    const TRIGGER_CALL = {
      method: "POST",
      path: `/v1/routines/${ROUTINE_ID}/trigger`,
      schema: "RoutineTriggerResponse",
    };

    function uploadingHttp(routine: unknown = PROMPT_ROUTINE) {
      const request = vi.fn(async (opts: { method: string; path: string }) => {
        if (opts.path === "/v1/files") return { id: UPLOADED_ID };
        return opts.method === "GET" ? routine : TRIGGERED;
      });
      return { request } as unknown as HttpClient;
    }

    it("auto: reads a platform routine and sends its parameters inline, with no upload", async () => {
      const http = uploadingHttp(PLATFORM_ROUTINE);
      const result = await new RoutinesApi(http).trigger(ROUTINE_ID, {
        parameters: { conversation_ids: ["conv-1"] },
      });

      expect(calls(http)).toEqual([
        READ,
        {
          ...TRIGGER_CALL,
          body: { parameters: { conversation_ids: ["conv-1"] } },
        },
      ]);
      expect(result.status).toBe("triggered");
    });

    it("auto: sends no file to a routine that posts into an existing task", async () => {
      const http = uploadingHttp(ROUTINE_FIXTURE);
      await new RoutinesApi(http).trigger(ROUTINE_ID, {
        parameters: { a: 1 },
      });

      expect(calls(http)).toEqual([
        READ,
        { ...TRIGGER_CALL, body: { parameters: { a: 1 } } },
      ]);
    });

    it("auto: reads a prompt routine, uploads under a unique name, then triggers with the file", async () => {
      const http = uploadingHttp();
      const parameters = { customer: { id: "cus_1", plan: "team" } };

      const result = await new RoutinesApi(http).trigger(ROUTINE_ID, {
        parameters,
        files: [EXTRA_FILE],
      });

      const [read, upload, trigger] = calls(http);
      expect(calls(http)).toHaveLength(3);
      expect(read).toEqual(READ);
      expect(upload).toMatchObject({
        method: "POST",
        path: "/v1/files",
        schema: "File",
        body: {
          content: JSON.stringify(parameters),
          mime_type: "application/json",
          ttl_seconds: 2592000,
        },
      });
      expect(upload.body.name).toMatch(
        /^routine-parameters\/[0-9a-f-]{36}\.json$/,
      );
      expect(trigger).toEqual({
        ...TRIGGER_CALL,
        body: {
          parameters,
          files: [{ id: UPLOADED_ID, name: "parameters.json" }, EXTRA_FILE],
        },
      });
      expect(result.task_id).toBe(TASK_ID);
    });

    it("attachParametersFile: true uploads without reading, each under a unique name", async () => {
      const http = uploadingHttp(PLATFORM_ROUTINE);
      const routines = new RoutinesApi(http);
      await routines.trigger(ROUTINE_ID, {
        parameters: { a: 1 },
        attachParametersFile: true,
      });
      await routines.trigger(ROUTINE_ID, {
        parameters: { a: 1 },
        attachParametersFile: true,
      });

      expect(calls(http).map((call) => [call.method, call.path])).toEqual([
        ["POST", "/v1/files"],
        ["POST", `/v1/routines/${ROUTINE_ID}/trigger`],
        ["POST", "/v1/files"],
        ["POST", `/v1/routines/${ROUTINE_ID}/trigger`],
      ]);
      const names = calls(http)
        .filter((call) => call.path === "/v1/files")
        .map((call) => call.body.name);
      expect(names[0]).not.toBe(names[1]);
    });

    it("attachParametersFile: false sends the parameters inline without reading", async () => {
      const http = uploadingHttp();
      await new RoutinesApi(http).trigger(ROUTINE_ID, {
        parameters: { a: 1 },
        attachParametersFile: false,
      });

      expect(calls(http)).toEqual([
        { ...TRIGGER_CALL, body: { parameters: { a: 1 } } },
      ]);
    });

    it("sends only the reference for a file id, with no read or upload", async () => {
      const http = uploadingHttp();
      const routines = new RoutinesApi(http);

      await routines.trigger(ROUTINE_ID, {
        parameters: UPLOADED_ID,
        files: [EXTRA_FILE],
      });
      await routines.trigger(ROUTINE_ID, {
        parameters: UPLOADED_ID,
        attachParametersFile: true,
      });

      expect(calls(http)).toEqual([
        {
          ...TRIGGER_CALL,
          body: {
            files: [{ id: UPLOADED_ID, name: "parameters.json" }, EXTRA_FILE],
          },
        },
        {
          ...TRIGGER_CALL,
          body: { files: [{ id: UPLOADED_ID, name: "parameters.json" }] },
        },
      ]);
    });

    it("refuses a string that is not a file id, sending nothing", async () => {
      const http = uploadingHttp();
      await expect(
        new RoutinesApi(http).trigger(ROUTINE_ID, {
          parameters: "routine-parameters/params.json",
        }),
      ).rejects.toThrow(
        new TypeError(
          "parameters must be a JSON object or a Files API file id (a UUID)",
        ),
      );
      expect(calls(http)).toEqual([]);
    });

    it("passes files through without parameters", async () => {
      const http = mockHttp({ requestResult: TRIGGERED });
      await new RoutinesApi(http).trigger(ROUTINE_ID, { files: [EXTRA_FILE] });

      expect(calls(http)).toEqual([
        {
          method: "POST",
          path: `/v1/routines/${ROUTINE_ID}/trigger`,
          schema: "RoutineTriggerResponse",
          body: { files: [EXTRA_FILE] },
        },
      ]);
    });
  });

  it("RoutineTaskMetadata types the keys a routine run stamps", () => {
    const metadata: RoutineTaskMetadata = {
      trigger_source: "trigger",
      routine_trigger: {
        trigger_id: TRIGGER_ID,
        event_type: "build.failed",
        delivery_id: "webhook:msg_1",
      },
      unresolved_parameters: ["build_url"],
    };
    expect(metadata.routine_trigger?.event_type).toBe("build.failed");
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

  it("uploads a manual trigger's parameters on the Data Plane, and sends no body without them", async () => {
    const triggered = {
      status: "triggered",
      routine_id: ROUTINE_ID,
      task_id: TASK_ID,
      run_id: null,
      reason: null,
      result: null,
    };
    const fileId = "0199a1b2-0000-7000-8000-0000000000f1";
    const { sdk, requests } = client([
      { ...ROUTINE_FIXTURE, task_id: null },
      { id: fileId },
      triggered,
      triggered,
    ]);

    await sdk.routines.trigger(ROUTINE_ID, {
      parameters: { customer: { id: "cus_1", plan: "team" } },
    });
    await sdk.routines.trigger(ROUTINE_ID);

    expect(requests.map((r) => [r.method, r.url.href])).toEqual([
      ["GET", `https://dp.test/v1/routines/${ROUTINE_ID}`],
      ["POST", "https://dp.test/v1/files"],
      ["POST", `https://dp.test/v1/routines/${ROUTINE_ID}/trigger`],
      ["POST", `https://dp.test/v1/routines/${ROUTINE_ID}/trigger`],
    ]);
    expect(requests[1].body).toMatchObject({
      content: '{"customer":{"id":"cus_1","plan":"team"}}',
      mime_type: "application/json",
      ttl_seconds: 2592000,
    });
    expect(requests[2].body).toEqual({
      parameters: { customer: { id: "cus_1", plan: "team" } },
      files: [{ id: fileId, name: "parameters.json" }],
    });
    expect(requests[3].body).toBeUndefined();
    expect(
      requests.some((r) => r.url.pathname.startsWith("/v1/automations")),
    ).toBe(false);
    await sdk.shutdown();
  });
});
