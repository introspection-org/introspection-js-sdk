import { describe, expect, it } from "vitest";
import {
  EventType,
  RateLimitError,
  TaskRunsApi,
  type ResumableTurnEvent,
  type StreamTurnOptions,
} from "@introspection-sdk/introspection-node";
import type {
  ConversationItem,
  ConversationItemList,
  TaskStatus,
} from "@introspection-sdk/types";

const encoder = new TextEncoder();

function frame(event: object): string {
  return `event: ag_ui\ndata: ${JSON.stringify(event)}\n\n`;
}

/** A stream that emits `frames` then closes cleanly (DP closed it = done). */
function cleanStream(...frames: string[]): () => Response {
  return () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const f of frames) controller.enqueue(encoder.encode(f));
          controller.close();
        },
      }),
    );
}

/** A stream that emits `frames` then errors mid-flight (severed connection). */
function severedStream(...frames: string[]): () => Response {
  return () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const f of frames) controller.enqueue(encoder.encode(f));
          controller.error(new Error("connection reset"));
        },
      }),
    );
}

/**
 * An attach that the DP rejects with `429` (not attachable yet) — the
 * readiness contract the client backs off and retries against.
 */
function rateLimited(status: string, retryAfterS: number | null): () => never {
  return () => {
    throw new RateLimitError({
      status: 429,
      code: null,
      requestId: null,
      body: { status },
      retryAfter: retryAfterS,
    });
  };
}

function item(id: string): ConversationItem {
  return {
    object: "conversation.item",
    id,
    type: "span",
    trace_id: "t",
    span_id: id,
    created_at: "2025-01-01T00:00:00Z",
    span_name: "x",
    span_kind: "INTERNAL",
  } as ConversationItem;
}

interface FakeOpts {
  /** One factory per `/stream` attempt, consumed in order. */
  streams: Array<() => Response>;
  /** Task status returned by `GET /v1/tasks/{id}`, in call order (or const). */
  status?: TaskStatus | TaskStatus[];
  /**
   * Transcript items endpoint. Returns the items that have "landed" so far
   * strictly after `after`. Defaults to a static `landed` list.
   */
  items?: (after: string | undefined, limit: number) => ConversationItem[];
  landed?: ConversationItem[];
}

class FakeHttp {
  streamCalls = 0;
  statusCalls = 0;
  itemsCalls = 0;
  private statusList: TaskStatus[];

  constructor(private readonly o: FakeOpts) {
    this.statusList = Array.isArray(o.status)
      ? o.status
      : o.status
        ? [o.status]
        : [];
  }

  async request<T>(opts: {
    method: string;
    path: string;
    query?: Record<string, unknown>;
  }): Promise<T> {
    if (opts.path.includes("/items")) {
      this.itemsCalls += 1;
      const after = opts.query?.after as string | undefined;
      const limit = (opts.query?.limit as number) ?? 200;
      const all = this.o.items
        ? this.o.items(after, limit)
        : afterStrict(this.o.landed ?? [], after);
      const page = all.slice(0, limit);
      const list: ConversationItemList = {
        object: "list",
        data: page,
        first_id: page[0]?.id ?? null,
        last_id: page[page.length - 1]?.id ?? null,
        has_more: all.length > page.length,
      };
      return list as T;
    }
    // GET /v1/tasks/{id}
    const idx = Math.min(this.statusCalls, this.statusList.length - 1);
    this.statusCalls += 1;
    const status = this.statusList[idx] ?? "running";
    return { id: "task-1", status } as T;
  }

  async stream(): Promise<Response> {
    const factory = this.o.streams[this.streamCalls];
    this.streamCalls += 1;
    if (!factory) throw new Error("connection reset");
    return factory();
  }
}

function afterStrict(
  all: ConversationItem[],
  after: string | undefined,
): ConversationItem[] {
  if (!after) return all;
  const i = all.findIndex((it) => it.id === after);
  return i < 0 ? all : all.slice(i + 1);
}

async function collect(
  http: FakeHttp,
  opts: StreamTurnOptions,
): Promise<ResumableTurnEvent[]> {
  const api = new TaskRunsApi(http as never);
  const out: ResumableTurnEvent[] = [];
  for await (const ev of api.streamTurn("task-1", "run-1", opts)) out.push(ev);
  return out;
}

const transcriptIds = (events: ResumableTurnEvent[]): string[] =>
  events
    .filter(
      (e): e is { type: "transcript"; item: ConversationItem } =>
        e.type === "transcript",
    )
    .map((e) => e.item.id);

const waitingStatuses = (events: ResumableTurnEvent[]): (string | null)[] =>
  events
    .filter(
      (
        e,
      ): e is {
        type: "waiting";
        status: string | null;
        retryAfterMs: number | null;
      } => e.type === "waiting",
    )
    .map((e) => e.status);

describe("streamTurn (resumable)", () => {
  it("clean completion → one hydrateGap tail, zero resumes, items once", async () => {
    const http = new FakeHttp({
      streams: [
        cleanStream(
          frame({
            type: EventType.RUN_FINISHED,
            threadId: "task-1",
            runId: "run-1",
          }),
        ),
      ],
      landed: [item("a"), item("b")],
    });
    const events = await collect(http, { resume: true, graceWindowMs: 50 });

    expect(http.streamCalls).toBe(1); // zero resumes
    expect(http.statusCalls).toBe(0); // clean close never reads status
    expect(transcriptIds(events)).toEqual(["a", "b"]);
    expect(events.at(-1)).toEqual({
      type: "settled",
      ok: true,
      status: "completed",
    });
  });

  it("mid-turn drop, still running → gap hydrated, re-attached, no dup/miss", async () => {
    // First attempt severs after one live frame; the rest lands in the
    // transcript; second attempt closes cleanly.
    const http = new FakeHttp({
      streams: [
        severedStream(
          frame({
            type: EventType.RUN_STARTED,
            threadId: "task-1",
            runId: "run-1",
          }),
        ),
        cleanStream(
          frame({
            type: EventType.RUN_FINISHED,
            threadId: "task-1",
            runId: "run-1",
          }),
        ),
      ],
      status: "running",
      landed: [item("a"), item("b"), item("c")],
    });
    const events = await collect(http, { resume: true, graceWindowMs: 50 });

    expect(http.streamCalls).toBe(2); // one resume
    expect(http.statusCalls).toBe(1);
    // Items deduped across both catch-ups: each exactly once.
    expect(transcriptIds(events)).toEqual(["a", "b", "c"]);
    expect(events.at(-1)).toEqual({
      type: "settled",
      ok: true,
      status: "completed",
    });
  });

  it("drop at/after completion → cheap status completed, final catch-up, settled", async () => {
    const http = new FakeHttp({
      streams: [severedStream()],
      status: "completed",
      landed: [item("a")],
    });
    const events = await collect(http, { resume: true, graceWindowMs: 50 });

    expect(http.streamCalls).toBe(1); // status said done, no re-attach
    expect(http.statusCalls).toBe(1);
    expect(transcriptIds(events)).toEqual(["a"]);
    expect(events.at(-1)).toEqual({
      type: "settled",
      ok: true,
      status: "completed",
    });
  });

  it("ingest lag right after a drop → grace-window poll eventually returns items", async () => {
    let itemCalls = 0;
    const http = new FakeHttp({
      streams: [
        cleanStream(
          frame({
            type: EventType.RUN_FINISHED,
            threadId: "task-1",
            runId: "run-1",
          }),
        ),
      ],
      // The item only becomes queryable on the 3rd items call (ingest lag).
      items: (after) => {
        itemCalls += 1;
        return itemCalls >= 3 ? afterStrict([item("late")], after) : [];
      },
    });
    const events = await collect(http, {
      resume: true,
      graceWindowMs: 1000,
      pollMs: 1,
    });

    expect(transcriptIds(events)).toEqual(["late"]);
    expect(itemCalls).toBeGreaterThanOrEqual(3);
    expect(events.at(-1)).toMatchObject({ type: "settled", ok: true });
  });

  it("exhausted maxResumes → NOT_SETTLED, no infinite reconnect", async () => {
    // Every attempt severs and the task stays running forever.
    const http = new FakeHttp({
      streams: [
        severedStream(),
        severedStream(),
        severedStream(),
        severedStream(),
      ],
      status: "running",
    });
    const events = await collect(http, {
      resume: true,
      maxResumes: 2,
      graceWindowMs: 10,
    });

    expect(http.streamCalls).toBe(3); // maxResumes + 1 attempts, then stop
    expect(events.at(-1)).toEqual({ type: "exhausted" });
  });

  it("failed/cancelled mid-turn → SETTLED(ok=false) promptly, no re-attach", async () => {
    const http = new FakeHttp({
      streams: [severedStream(), severedStream()],
      status: "failed",
      landed: [item("a")],
    });
    const events = await collect(http, { resume: true, graceWindowMs: 10 });

    expect(http.streamCalls).toBe(1); // failed → stop immediately
    expect(events.at(-1)).toEqual({
      type: "settled",
      ok: false,
      status: "failed",
    });
  });

  it("resume:false → pure passthrough, no status/transcript reads", async () => {
    const http = new FakeHttp({
      streams: [
        cleanStream(
          frame({
            type: EventType.RUN_FINISHED,
            threadId: "task-1",
            runId: "run-1",
          }),
        ),
      ],
      landed: [item("a")],
    });
    const events = await collect(http, { resume: false });

    expect(http.streamCalls).toBe(1);
    expect(http.statusCalls).toBe(0);
    expect(http.itemsCalls).toBe(0); // no transcript catch-up when opted out
    expect(transcriptIds(events)).toEqual([]);
    expect(events.at(-1)).toEqual({
      type: "settled",
      ok: true,
      status: "completed",
    });
  });

  it("429 readiness → backs off per Retry-After, attaches, no resume burned", async () => {
    // DP not attachable yet on the first two attaches, then live.
    const http = new FakeHttp({
      streams: [
        rateLimited("provisioning", 0),
        rateLimited("starting", 0),
        cleanStream(
          frame({
            type: EventType.RUN_FINISHED,
            threadId: "task-1",
            runId: "run-1",
          }),
        ),
      ],
      landed: [item("a")],
    });
    const events = await collect(http, {
      resume: true,
      retryBackoffMs: 1,
      graceWindowMs: 20,
      maxResumes: 0, // 429 retries must NOT consume the (zero) resume budget
    });

    expect(http.streamCalls).toBe(3); // two 429s + one live attach
    expect(http.statusCalls).toBe(0); // 429 is readiness, never a settle check
    expect(waitingStatuses(events)).toEqual(["provisioning", "starting"]);
    expect(transcriptIds(events)).toEqual(["a"]);
    expect(events.at(-1)).toEqual({
      type: "settled",
      ok: true,
      status: "completed",
    });
  });

  it("429 forever → bounded by deadline, returns exhausted", async () => {
    const http = new FakeHttp({
      streams: Array.from({ length: 50 }, () => rateLimited("provisioning", 0)),
    });
    const events = await collect(http, {
      resume: true,
      retryBackoffMs: 1,
      timeoutMs: 30, // overall deadline bounds the readiness wait
    });

    expect(events.at(-1)).toEqual({ type: "exhausted" });
    expect(waitingStatuses(events).length).toBeGreaterThan(0);
  });
});
