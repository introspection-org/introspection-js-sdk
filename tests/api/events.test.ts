import { describe, expect, it, vi } from "vitest";
import * as arrow from "apache-arrow";
import {
  ConversationsApi,
  EventsApi,
  IntrospectionEventNames,
  isKnownEvent,
  HttpClient,
} from "@introspection-sdk/introspection-node";
import type { Event } from "@introspection-sdk/introspection-node";

function mockHttp(overrides: Record<string, unknown> = {}) {
  return {
    request: vi.fn().mockResolvedValue(overrides.requestResult ?? {}),
    stream: vi.fn().mockResolvedValue(overrides.streamResult ?? new Response()),
  } as unknown as HttpClient;
}

const ENVELOPE = {
  timestamp: "2025-01-01T00:00:00Z",
  conversation_id: "conv-1",
  service_name: "svc",
  environment: "production",
};

// ---------------------------------------------------------------------------
// Compile-level contract. These functions are type assertions: they must
// compile (discriminant narrowing on the closed union), while the lines
// annotated with ts-expect-error must fail to compile (event_name is a
// required property of the list()/arrow() params).
// ---------------------------------------------------------------------------

/** Narrowing on the top-level `event_name` discriminator must work. */
function narrowEvent(ev: Event): string | null | undefined {
  if (ev.event_name === "introspection.feedback") {
    return ev.payload.name;
  }
  if (ev.event_name === "introspection.judgement") {
    return ev.payload.judgement_id;
  }
  if (ev.event_name === "introspection.observation") {
    return ev.payload.pattern_id;
  }
  if (ev.event_name === "introspection.pattern") {
    return ev.payload.status;
  }
  if (ev.event_name === "introspection.pattern.assignment") {
    return ev.payload.pattern_id;
  }
  return ev.payload.run_id; // narrowed to ClusteringRunEvent
}

function requireEventNameAtCompileTime(api: EventsApi): void {
  // @ts-expect-error — `event_name` is a required param of list()
  void api.list({ limit: 5 });
  // @ts-expect-error — `event_name` is a required param of list()
  void api.list();
  // @ts-expect-error — `event_name` is a required param of arrow()
  void api.arrow({ limit: 5 });
}
void requireEventNameAtCompileTime;

describe("EventsApi.list — typed families (JSON)", () => {
  it("returns FeedbackEvent rows with the typed payload", async () => {
    const http = mockHttp({
      requestResult: {
        records: [
          {
            ...ENVELOPE,
            id: "ev-fb-1",
            event_name: "introspection.feedback",
            payload: {
              name: "thumbs_up",
              comments: "great answer",
              value: 1,
              user_id: "user-1",
              anonymous_id: null,
              sentiment: "positive",
              previous_response_id: "resp-42",
              agent_name: "support-agent",
              agent_id: "agent-7",
              properties: { surface: "chat" },
            },
          },
        ],
        count: 1,
        next: null,
      },
    });
    const api = new EventsApi(http);
    const page = await api.list({ event_name: "introspection.feedback" });
    const ev = page.records[0];

    // `ev` is typed FeedbackEvent — payload fields are statically known.
    expect(ev.event_name).toBe(IntrospectionEventNames.FEEDBACK);
    expect(ev.payload.name).toBe("thumbs_up");
    expect(ev.payload.comments).toBe("great answer");
    expect(ev.payload.value).toBe(1);
    expect(ev.payload.user_id).toBe("user-1");
    expect(ev.payload.sentiment).toBe("positive");
    expect(ev.payload.previous_response_id).toBe("resp-42");
    expect(ev.payload.agent_name).toBe("support-agent");
    expect(ev.payload.agent_id).toBe("agent-7");
    expect(ev.payload.properties).toEqual({ surface: "chat" });
    expect(isKnownEvent(ev)).toBe(true);
    expect(narrowEvent(ev)).toBe("thumbs_up");
  });

  it("decodes an unassignment (pattern_id null) into the typed PatternAssignment member", async () => {
    const http = mockHttp({
      requestResult: {
        records: [
          {
            ...ENVELOPE,
            id: "ev-pa-1",
            event_name: "introspection.pattern.assignment",
            payload: {
              observation_id: "0195fb1a-0000-7000-8000-000000000002",
              // null = explicitly unassigned; observation_id alone is identity.
              pattern_id: null,
              method: "manual",
              run_id: "run-3",
              score: null,
            },
          },
        ],
        count: 1,
        next: null,
      },
    });
    const api = new EventsApi(http);
    const page = await api.list({
      event_name: "introspection.pattern.assignment",
    });
    const ev = page.records[0];

    expect(ev.event_name).toBe(IntrospectionEventNames.PATTERN_ASSIGNMENT);
    expect(ev.payload.observation_id).toBe(
      "0195fb1a-0000-7000-8000-000000000002",
    );
    expect(ev.payload.pattern_id).toBeNull();
    expect(ev.payload.method).toBe("manual");
    expect(isKnownEvent(ev)).toBe(true);
    // Narrowing on the discriminant still compiles with the nullable
    // pattern_id (narrowEvent returns it from the assignment branch).
    expect(narrowEvent(ev)).toBeNull();
  });

  it("returns ObservationEvent rows with the fold fields in the payload", async () => {
    const http = mockHttp({
      requestResult: {
        records: [
          {
            ...ENVELOPE,
            id: "ev-obs-1",
            event_name: "introspection.observation",
            payload: {
              observation_id: "0195fb1a-0000-7000-8000-000000000001",
              lens: "task_outcome",
              label: "wrong_tool",
              summary: "Agent picked the wrong tool",
              severity: "high",
              confidence: 0.92,
              replaces_observation_id: null,
              // fold: CURRENT assignment joined from later events
              pattern_id: "pat-7",
              assignment_score: 0.81,
              assignment_method: "hdbscan",
              metadata: { source: "lens" },
            },
          },
        ],
        count: 1,
        next: null,
      },
    });
    const api = new EventsApi(http);
    const page = await api.list({
      event_name: "introspection.observation",
      pattern_id: "pat-7",
      include_superseded: false,
    });
    const ev = page.records[0];

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/events",
      query: {
        event_name: "introspection.observation",
        pattern_id: "pat-7",
        include_superseded: false,
      },
      signal: undefined,
    });
    expect(ev.payload.observation_id).toBe(
      "0195fb1a-0000-7000-8000-000000000001",
    );
    expect(ev.payload.lens).toBe("task_outcome");
    expect(ev.payload.pattern_id).toBe("pat-7");
    expect(ev.payload.assignment_score).toBe(0.81);
    expect(ev.payload.assignment_method).toBe("hdbscan");
  });

  it("returns PatternEvent catalog rows with the fold fields in the payload", async () => {
    const http = mockHttp({
      requestResult: {
        records: [
          {
            ...ENVELOPE,
            id: "ev-pat-1",
            event_name: "introspection.pattern",
            payload: {
              pattern_id: "pat-7",
              action: "updated",
              name: "Wrong tool selection",
              lens: "task_outcome",
              status: "active",
              created_at: "2024-12-01T00:00:00Z",
              updated_at: "2025-01-01T00:00:00Z",
              retired_at: null,
              last_detected_at: "2025-01-01T00:00:00Z",
            },
          },
        ],
        count: 1,
        next: null,
      },
    });
    const api = new EventsApi(http);
    const page = await api.list({
      event_name: "introspection.pattern",
      status: "active",
      sort: "updated_at",
    });
    const ev = page.records[0];

    const query = (http.request as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .query;
    expect(query.status).toBe("active");
    expect(query.sort).toBe("updated_at");
    expect(ev.payload.pattern_id).toBe("pat-7");
    expect(ev.payload.action).toBe("updated");
    expect(ev.payload.status).toBe("active");
    expect(ev.payload.last_detected_at).toBe("2025-01-01T00:00:00Z");
    expect(narrowEvent(ev)).toBe("active");
  });

  it("returns JudgementEvent rows with the typed payload", async () => {
    const http = mockHttp({
      requestResult: {
        records: [
          {
            ...ENVELOPE,
            id: "ev-j-1",
            event_name: "introspection.judgement",
            payload: {
              judgement_id: "judg-1",
              judge_id: "judge-9",
              result: "pass",
              definition_hash: "abc123",
              contract_version: "1",
              sequence_hash: "def456",
              experiment_arm_id: "0195fb1a-0000-7000-8000-00000000000a",
            },
          },
        ],
        count: 1,
        next: null,
      },
    });
    const api = new EventsApi(http);
    const page = await api.list({ event_name: "introspection.judgement" });
    const ev = page.records[0];
    expect(ev.payload.judgement_id).toBe("judg-1");
    expect(ev.payload.result).toBe("pass");
    expect(ev.payload.experiment_arm_id).toBe(
      "0195fb1a-0000-7000-8000-00000000000a",
    );
  });

  it("surfaces rows of an unknown family as a structurally-typed fallback (never throws)", async () => {
    const http = mockHttp({
      requestResult: {
        records: [
          {
            ...ENVELOPE,
            id: "ev-new-1",
            event_name: "introspection.new_family",
            payload: { some_field: "some_value" },
          },
        ],
        count: 1,
        next: null,
      },
    });
    const api = new EventsApi(http);
    // An event_name outside the known set compiles (forward compat) and
    // types the rows as UnknownEvent.
    const page = await api.list({ event_name: "introspection.new_family" });
    const ev = page.records[0];

    expect(ev.id).toBe("ev-new-1");
    expect(ev.event_name).toBe("introspection.new_family");
    expect(ev.payload).toEqual({ some_field: "some_value" });
    expect(isKnownEvent(ev)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Arrow — struct payload column round-trip + the columnar arrow() accessor.
// ---------------------------------------------------------------------------

const FEEDBACK_PAYLOAD_TYPE = new arrow.Struct([
  new arrow.Field("name", new arrow.Utf8(), true),
  new arrow.Field("comments", new arrow.Utf8(), true),
  new arrow.Field("value", new arrow.Float64(), true),
]);

const SERVER_FEEDBACK_PAYLOAD_TYPE = new arrow.Struct([
  new arrow.Field("name", new arrow.Utf8(), false),
  // Open dict fields are JSON-encoded strings in the server's fixed schema.
  new arrow.Field("properties", new arrow.Utf8(), true),
]);

/** A REAL Arrow IPC stream: envelope columns + a struct payload column. */
function feedbackIpc(
  ids: string[],
  payloads: { name: string; comments: string | null; value: number | null }[],
): Uint8Array {
  const table = new arrow.Table({
    id: arrow.vectorFromArray(ids, new arrow.Utf8()),
    event_name: arrow.vectorFromArray(
      ids.map(() => "introspection.feedback"),
      new arrow.Utf8(),
    ),
    payload: arrow.vectorFromArray(payloads, FEEDBACK_PAYLOAD_TYPE),
  });
  return arrow.tableToIPC(table, "stream");
}

describe("EventsApi.list — Arrow with a struct payload column", () => {
  it("decodes the payload struct into plain nested objects matching the JSON shape", async () => {
    const ipc = feedbackIpc(
      ["ev-1", "ev-2"],
      [
        { name: "thumbs_up", comments: "nice", value: 1 },
        { name: "thumbs_down", comments: null, value: 0 },
      ],
    );
    const http = mockHttp({
      streamResult: new Response(ipc, {
        headers: { "x-result-count": "2", "x-truncated": "false" },
      }),
    });
    const api = new EventsApi(http);
    const page = await api.list({
      event_name: "introspection.feedback",
      format: "arrow",
    });

    expect(page.records).toEqual([
      {
        id: "ev-1",
        event_name: "introspection.feedback",
        payload: { name: "thumbs_up", comments: "nice", value: 1 },
      },
      {
        id: "ev-2",
        event_name: "introspection.feedback",
        payload: { name: "thumbs_down", comments: null, value: 0 },
      },
    ]);
    // The decoded payload is a PLAIN object (not an Arrow StructRow
    // proxy), so JSON and Arrow rows are interchangeable.
    expect(Object.getPrototypeOf(page.records[0].payload)).toBe(
      Object.prototype,
    );
    expect(page.records[0].payload.name).toBe("thumbs_up");
  });

  it("restores server-native timestamps and JSON-encoded dict payload fields", async () => {
    const table = new arrow.Table({
      id: arrow.vectorFromArray(["ev-1"], new arrow.Utf8()),
      timestamp: arrow.vectorFromArray(
        [new Date("2026-07-17T00:00:00.000Z")],
        new arrow.TimestampMicrosecond(),
      ),
      event_name: arrow.vectorFromArray(
        ["introspection.feedback"],
        new arrow.Utf8(),
      ),
      payload: arrow.vectorFromArray(
        [
          {
            name: "thumbs_up",
            properties: JSON.stringify({ surface: "chat" }),
          },
        ],
        SERVER_FEEDBACK_PAYLOAD_TYPE,
      ),
    });
    const http = mockHttp({
      streamResult: new Response(arrow.tableToIPC(table, "stream")),
    });

    const page = await new EventsApi(http).list({
      event_name: "introspection.feedback",
      format: "arrow",
    });

    expect(page.records[0].timestamp).toBe("2026-07-17T00:00:00.000Z");
    expect(page.records[0].payload.properties).toEqual({ surface: "chat" });
  });

  it("decodes the server's exact column encodings: dictionary strings, tz timestamps, list<string>, int64, JSON dict fields", async () => {
    // Mirrors the DP Arrow writer's schema traits: envelope
    // `event_name`/`environment`/`service_name` are DICTIONARY-encoded,
    // `timestamp` is timestamp('us', tz=UTC), `evidence_refs` is
    // list<string>, `segment` is int64, and open dict-shaped payload
    // fields (`metadata`) are JSON-encoded strings inside the struct.
    // Each dictionary-encoded column needs its own dictionary id.
    const dictUtf8 = (id: number) =>
      new arrow.Dictionary(new arrow.Utf8(), new arrow.Int32(), id);
    const payloadType = new arrow.Struct([
      new arrow.Field("observation_id", new arrow.Utf8(), false),
      new arrow.Field("lens", new arrow.Utf8(), true),
      new arrow.Field("segment", new arrow.Int64(), true),
      new arrow.Field(
        "evidence_refs",
        new arrow.List(new arrow.Field("item", new arrow.Utf8(), true)),
        true,
      ),
      new arrow.Field("metadata", new arrow.Utf8(), true),
    ]);
    const table = new arrow.Table({
      id: arrow.vectorFromArray(["ev-1"], new arrow.Utf8()),
      timestamp: arrow.vectorFromArray(
        [new Date("2026-07-17T03:00:00.000Z")],
        new arrow.TimestampMicrosecond("UTC"),
      ),
      event_name: arrow.vectorFromArray(
        ["introspection.observation"],
        dictUtf8(1),
      ),
      environment: arrow.vectorFromArray(["production"], dictUtf8(2)),
      service_name: arrow.vectorFromArray(["checkout-agent"], dictUtf8(3)),
      payload: arrow.vectorFromArray(
        [
          {
            observation_id: "obs-1",
            lens: "task_resolution",
            segment: 0n,
            evidence_refs: ["item-1", "item-2"],
            metadata: JSON.stringify({ k: "v", n: 2 }),
          },
        ],
        payloadType,
      ),
    });
    const http = mockHttp({
      streamResult: new Response(arrow.tableToIPC(table, "stream")),
    });

    const page = await new EventsApi(http).list({
      event_name: "introspection.observation",
      format: "arrow",
    });

    const ev = page.records[0];
    // Dictionary columns decode to plain strings, not index proxies.
    expect(ev.event_name).toBe("introspection.observation");
    expect(ev.environment).toBe("production");
    expect(ev.service_name).toBe("checkout-agent");
    // tz-aware microsecond timestamp normalizes to the ISO string the
    // JSON transport returns (the `Event` type declares `string`).
    expect(ev.timestamp).toBe("2026-07-17T03:00:00.000Z");
    if (ev.event_name !== "introspection.observation") throw new Error();
    // int64 decodes to a plain number, matching JSON (not a bigint).
    expect(ev.payload.segment).toBe(0);
    expect(typeof ev.payload.segment).toBe("number");
    // list<string> flattens to a plain array.
    expect(ev.payload.evidence_refs).toEqual(["item-1", "item-2"]);
    // JSON-encoded dict fields re-parse to objects, matching JSON.
    expect(ev.payload.metadata).toEqual({ k: "v", n: 2 });
  });
});

describe("EventsApi.arrow — columnar accessor", () => {
  it("yields one apache-arrow Table per page and readAll() concatenates", async () => {
    const page1 = new Response(
      feedbackIpc(
        ["ev-1", "ev-2"],
        [
          { name: "thumbs_up", comments: null, value: 1 },
          { name: "thumbs_down", comments: null, value: 0 },
        ],
      ),
      { headers: { "x-result-count": "2", "x-next-cursor": "cursor-2" } },
    );
    const page2 = new Response(
      feedbackIpc(["ev-3"], [{ name: "thumbs_up", comments: "!", value: 1 }]),
      { headers: { "x-result-count": "1" } },
    );

    const http = mockHttp();
    (http.stream as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);
    const api = new EventsApi(http);

    const tables: arrow.Table[] = [];
    for await (const table of api.arrow({
      event_name: "introspection.feedback",
      limit: 2,
    })) {
      tables.push(table);
    }

    expect(tables).toHaveLength(2);
    expect(tables[0]).toBeInstanceOf(arrow.Table);
    expect(tables[0].numRows).toBe(2);
    expect(tables[1].numRows).toBe(1);
    // Arrow was negotiated and the cursor driven across pages.
    expect(http.stream).toHaveBeenCalledWith({
      path: "/v1/events",
      query: { event_name: "introspection.feedback", limit: 2 },
      headers: { Accept: "application/vnd.apache.arrow.stream" },
      signal: undefined,
    });
    expect(
      (http.stream as ReturnType<typeof vi.fn>).mock.calls[1][0].query.next,
    ).toBe("cursor-2");
  });

  it("readAll() fetches every page into a single concatenated Table", async () => {
    const page1 = new Response(
      feedbackIpc(
        ["ev-1", "ev-2"],
        [
          { name: "a", comments: null, value: 1 },
          { name: "b", comments: null, value: 2 },
        ],
      ),
      { headers: { "x-next-cursor": "cursor-2" } },
    );
    const page2 = new Response(
      feedbackIpc(["ev-3"], [{ name: "c", comments: null, value: 3 }]),
      { headers: {} },
    );
    const http = mockHttp();
    (http.stream as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);
    const api = new EventsApi(http);

    const table = await api
      .arrow({ event_name: "introspection.feedback" })
      .readAll();

    expect(table).toBeInstanceOf(arrow.Table);
    expect(table.numRows).toBe(3);
    expect(table.getChild("id")?.get(2)).toBe("ev-3");
    // Struct payload column survives concatenation.
    const payloads = table.getChild("payload");
    expect(payloads?.get(0)?.name).toBe("a");
    expect(payloads?.get(2)?.name).toBe("c");
  });

  it("treats an empty body as an empty Table page", async () => {
    const http = mockHttp({
      streamResult: new Response(new Uint8Array(0), {
        headers: { "x-result-count": "0" },
      }),
    });
    const api = new EventsApi(http);
    const table = await api
      .arrow({ event_name: "introspection.feedback" })
      .readAll();
    expect(table.numRows).toBe(0);
  });
});

describe("ConversationsApi.arrow — columnar accessor", () => {
  it("yields Tables over /v1/conversations and readAll() concatenates", async () => {
    const makeIpc = (ids: string[]) =>
      arrow.tableToIPC(
        new arrow.Table({
          conversation_id: arrow.vectorFromArray(ids, new arrow.Utf8()),
        }),
        "stream",
      );
    const page1 = new Response(makeIpc(["c-1", "c-2"]), {
      headers: { "x-next-cursor": "cursor-2" },
    });
    const page2 = new Response(makeIpc(["c-3"]), { headers: {} });
    const http = mockHttp();
    (http.stream as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);
    const api = new ConversationsApi(http);

    const table = await api.arrow().readAll();

    expect(http.stream).toHaveBeenCalledWith({
      path: "/v1/conversations",
      query: {},
      headers: { Accept: "application/vnd.apache.arrow.stream" },
      signal: undefined,
    });
    expect(table.numRows).toBe(3);
    expect(table.getChild("conversation_id")?.get(0)).toBe("c-1");
  });
});
