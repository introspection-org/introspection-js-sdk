import { describe, expect, it, vi } from "vitest";
import { tableFromArrays, tableToIPC } from "apache-arrow";
import {
  EventsApi,
  MetricsApi,
  HttpClient,
  ValidationError,
} from "@introspection-sdk/introspection-node";
import type {
  EventListParams,
  MetricQueryRequest,
} from "@introspection-sdk/introspection-node";

function mockHttp(overrides: Record<string, unknown> = {}) {
  return {
    request: vi.fn().mockResolvedValue(overrides.requestResult ?? {}),
    stream: vi.fn().mockResolvedValue(overrides.streamResult ?? new Response()),
  } as unknown as HttpClient;
}

const EVENT_FIXTURE = {
  id: "ev-1",
  timestamp: "2025-01-01T00:00:00Z",
  conversation_id: "conv-1",
  event_name: "chat",
  service_name: "svc",
};

describe("EventsApi.list", () => {
  it("walks GET /v1/events with the cursor envelope and passes filters", async () => {
    const http = mockHttp({
      requestResult: { records: [EVENT_FIXTURE], count: 1, next: null },
    });
    const api = new EventsApi(http);
    const events = [];
    for await (const ev of api.list({
      limit: 10,
      grain: "raw",
      event_name: "chat",
    })) {
      events.push(ev);
    }

    expect(http.request).toHaveBeenCalledWith({
      method: "GET",
      path: "/v1/events",
      query: { limit: 10, grain: "raw", event_name: "chat" },
      signal: undefined,
    });
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("ev-1");
  });

  it("maps ergonomic order/start/end onto the wire params", async () => {
    const http = mockHttp({
      requestResult: { records: [], count: 0, next: null },
    });
    const api = new EventsApi(http);
    await api.list({
      order: "asc",
      start: "2025-01-01T00:00:00Z",
      end: "2025-01-02T00:00:00Z",
    } as EventListParams);

    const query = (http.request as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .query;
    expect(query.direction).toBe("asc");
    expect(query.start_date).toBe("2025-01-01T00:00:00Z");
    expect(query.end_date).toBe("2025-01-02T00:00:00Z");
    // Ergonomic keys must not leak onto the wire.
    expect(query.order).toBeUndefined();
    expect(query.start).toBeUndefined();
    expect(query.end).toBeUndefined();
  });

  it("computes start_date from a relative lookback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-02T00:00:00.000Z"));
    const http = mockHttp({
      requestResult: { records: [], count: 0, next: null },
    });
    const api = new EventsApi(http);
    await api.list({ lookback: "24h" });
    const query = (http.request as ReturnType<typeof vi.fn>).mock.calls[0][0]
      .query;
    expect(query.start_date).toBe("2025-01-01T00:00:00.000Z");
    vi.useRealTimers();
  });

  it("throws a ValidationError when lookback is combined with a window", async () => {
    const http = mockHttp();
    const api = new EventsApi(http);
    expect(() =>
      api.list({ lookback: "24h", start: "2025-01-01T00:00:00Z" }),
    ).toThrow(ValidationError);
    expect(http.request).not.toHaveBeenCalled();
  });

  it("throws a ValidationError on an unparseable lookback", () => {
    const http = mockHttp({
      requestResult: { records: [], count: 0, next: null },
    });
    const api = new EventsApi(http);
    expect(() => api.list({ lookback: "soon" })).toThrow(ValidationError);
    expect(http.request).not.toHaveBeenCalled();
  });

  it("drives the cursor `next` token until exhausted", async () => {
    const page1 = {
      records: [EVENT_FIXTURE],
      count: 1,
      total_count: 2,
      next: "cursor-2",
    };
    const page2 = {
      records: [{ ...EVENT_FIXTURE, id: "ev-2" }],
      count: 1,
      total_count: 2,
      next: null,
    };
    const http = mockHttp();
    (http.request as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2);
    const api = new EventsApi(http);
    const events = [];
    for await (const ev of api.list()) events.push(ev);

    expect(events).toHaveLength(2);
    expect(events[1].id).toBe("ev-2");
    expect(
      (http.request as ReturnType<typeof vi.fn>).mock.calls[1][0].query.next,
    ).toBe("cursor-2");
  });
});

describe("EventsApi.list — Arrow format", () => {
  function arrowResponse(
    rows: Record<string, string[]>,
    headers: Record<string, string>,
  ): Response {
    const ipc = tableToIPC(tableFromArrays(rows), "stream");
    return new Response(ipc, { headers });
  }

  it("negotiates Arrow and rebuilds the Paginated shape from headers", async () => {
    const http = mockHttp({
      streamResult: arrowResponse(
        { id: ["ev-1", "ev-2"], event_name: ["chat", "chat"] },
        {
          "x-result-count": "2",
          "x-truncated": "true",
          "x-next-cursor": "cursor-2",
          "x-total-count": "9",
        },
      ),
    });
    const api = new EventsApi(http);
    const page = await api.list({ format: "arrow", limit: 2 });

    // Accept header negotiated, and ergonomic/control keys stripped.
    expect(http.stream).toHaveBeenCalledWith({
      path: "/v1/events",
      query: { limit: 2 },
      headers: { Accept: "application/vnd.apache.arrow.stream" },
      signal: undefined,
    });
    expect(page.records).toEqual([
      { id: "ev-1", event_name: "chat" },
      { id: "ev-2", event_name: "chat" },
    ]);
    expect(page.count).toBe(2);
    expect(page.total_count).toBe(9);
    expect(page.next).toBe("cursor-2");
  });

  it("reports no next cursor on the final Arrow page", async () => {
    const http = mockHttp({
      streamResult: arrowResponse(
        { id: ["ev-1"] },
        { "x-result-count": "1", "x-truncated": "false" },
      ),
    });
    const api = new EventsApi(http);
    const page = await api.list({ format: "arrow" });
    expect(page.next).toBeNull();
    expect(page.total_count).toBeNull();
    expect(page.records).toEqual([{ id: "ev-1" }]);
  });

  it("decodes an empty Arrow page (empty body) to zero records without touching Arrow", async () => {
    // A zero-byte body must skip the `apache-arrow` decode entirely
    // (the `if (bytes.byteLength > 0)` guard in reads.ts) and still yield
    // a sane, exhausted Paginated envelope from the headers alone.
    const http = mockHttp({
      streamResult: new Response(new Uint8Array(0), {
        headers: { "x-result-count": "0", "x-truncated": "false" },
      }),
    });
    const api = new EventsApi(http);
    const page = await api.list({ format: "arrow" });

    expect(page.records).toEqual([]);
    expect(page.count).toBe(0);
    expect(page.total_count).toBeNull();
    expect(page.next).toBeNull();
  });

  it("auto-pages `for await` across two Arrow pages until the cursor is exhausted", async () => {
    const http = mockHttp();
    (http.stream as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(
        arrowResponse(
          { id: ["ev-1"], event_name: ["chat"] },
          {
            "x-result-count": "1",
            "x-truncated": "true",
            "x-next-cursor": "cursor-2",
            "x-total-count": "2",
          },
        ),
      )
      // Page 2 carries no `x-next-cursor` header, so iteration terminates.
      .mockResolvedValueOnce(
        arrowResponse(
          { id: ["ev-2"], event_name: ["chat"] },
          {
            "x-result-count": "1",
            "x-truncated": "false",
            "x-total-count": "2",
          },
        ),
      );

    const api = new EventsApi(http);
    const events = [];
    for await (const ev of api.list({ format: "arrow" })) events.push(ev);

    expect(events.map((e) => e.id)).toEqual(["ev-1", "ev-2"]);
    expect(http.stream).toHaveBeenCalledTimes(2);
    // The paginator threads the first page's cursor onto the second request.
    expect(
      (http.stream as ReturnType<typeof vi.fn>).mock.calls[1][0].query.next,
    ).toBe("cursor-2");
  });
});

describe("MetricsApi.query", () => {
  it("POSTs /v1/metrics with the request body and returns { data, meta }", async () => {
    const response = {
      data: [
        {
          timestamp: null,
          dimensions: [{ field: "gen_ai.response.model", value: "claude-x" }],
          metrics: [
            {
              metric_index: 0,
              measure: null,
              aggregation: "count",
              value: 42,
            },
          ],
        },
      ],
      meta: {
        view: "spans",
        window: { start: "2025-01-01T00:00:00Z", end: "2025-01-02T00:00:00Z" },
        row_count: 1,
        row_limit: 100,
        approximate: false,
        truncated: false,
        order_by: [],
      },
    };
    const http = mockHttp({ requestResult: response });
    const api = new MetricsApi(http);
    const request: MetricQueryRequest = {
      view: "spans",
      metrics: [{ aggregation: "count" }],
      dimensions: [{ field: "gen_ai.response.model" }],
      from_timestamp: "2025-01-01T00:00:00Z",
      to_timestamp: "2025-01-02T00:00:00Z",
    };
    const result = await api.query(request);

    expect(http.request).toHaveBeenCalledWith({
      method: "POST",
      path: "/v1/metrics",
      body: request,
      signal: undefined,
    });
    expect(result.data[0].metrics[0].value).toBe(42);
    expect(result.meta.view).toBe("spans");
  });
});
