import { describe, expect, it } from "vitest";
import {
  EventType,
  RateLimitError,
  TaskRunsApi,
  type StreamOptions,
} from "@introspection-sdk/introspection-node";
import type { AGUIEvent } from "@introspection-sdk/types";

const encoder = new TextEncoder();

interface Frame {
  id?: string;
  event: string;
  data: unknown;
}

function frameText({ id, event, data }: Frame): string {
  return (
    (id !== undefined ? `id: ${id}\n` : "") +
    `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
  );
}

function content(id: string, delta: string): Frame {
  return {
    id,
    event: "ag_ui",
    data: { type: EventType.TEXT_MESSAGE_CONTENT, messageId: "m", delta },
  };
}

const FINISH: Frame = {
  id: "c-0",
  event: "ag_ui",
  data: { type: EventType.RUN_FINISHED, threadId: "t", runId: "run-1" },
};

/** A stream that emits `frames` then closes cleanly (DP closed it = done). */
function clean(...frames: Frame[]): () => Response {
  return () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const f of frames)
            controller.enqueue(encoder.encode(frameText(f)));
          controller.close();
        },
      }),
    );
}

/**
 * A stream that emits `frames` then errors mid-flight (severed connection).
 * Pull-based: chunks are delivered on demand before the error, because
 * `controller.error()` resets any still-queued chunks (Streams spec), which
 * would otherwise drop frames enqueued in the same tick.
 */
function severed(...frames: Frame[]): () => Response {
  return () => {
    let i = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (i < frames.length) {
            controller.enqueue(encoder.encode(frameText(frames[i++])));
          } else {
            controller.error(new Error("connection reset"));
          }
        },
      }),
    );
  };
}

/** An attach the DP refuses with `429` (run not attachable yet). */
function rateLimited(retryAfterS: number | null): () => never {
  return () => {
    throw new RateLimitError({
      status: 429,
      code: null,
      requestId: null,
      body: { status: "provisioning" },
      retryAfter: retryAfterS,
    });
  };
}

class FakeHttp {
  streamCalls = 0;
  /** The `Last-Event-ID` header seen on each attach (null when absent). */
  lastEventIds: (string | null)[] = [];

  constructor(private readonly streams: Array<() => Response>) {}

  async request<T>(): Promise<T> {
    throw new Error("request() must not be called by the resumable stream");
  }

  async stream(opts: {
    path: string;
    headers?: Record<string, string>;
  }): Promise<Response> {
    this.lastEventIds.push(opts.headers?.["Last-Event-ID"] ?? null);
    const factory = this.streams[this.streamCalls];
    this.streamCalls += 1;
    if (!factory) throw new Error("connection reset");
    return factory();
  }
}

async function deltas(
  http: FakeHttp,
  opts: StreamOptions = {},
): Promise<string[]> {
  const api = new TaskRunsApi(http as never);
  const out: string[] = [];
  for await (const ev of api.stream("task-1", "run-1", opts)) {
    const e = ev as AGUIEvent & { delta?: string };
    if (e.type === EventType.TEXT_MESSAGE_CONTENT) out.push(e.delta ?? "");
  }
  return out;
}

const FAST: StreamOptions = { backoffMs: 1 };

describe("stream (transparent resume)", () => {
  it("clean completion → single attach, no reconnect", async () => {
    const http = new FakeHttp([
      clean(content("1", "a"), content("2", "b"), FINISH),
    ]);
    expect(await deltas(http, FAST)).toEqual(["a", "b"]);
    expect(http.streamCalls).toBe(1);
    expect(http.lastEventIds).toEqual([null]); // no resume header on first attach
  });

  it("mid-turn drop → re-attaches with Last-Event-ID, gap-free", async () => {
    const http = new FakeHttp([
      severed(content("1", "a"), content("2", "b")),
      clean(content("3", "c"), FINISH),
    ]);
    expect(await deltas(http, FAST)).toEqual(["a", "b", "c"]);
    expect(http.streamCalls).toBe(2);
    // Reconnect resumes from the last content-frame id the client saw.
    expect(http.lastEventIds).toEqual([null, "2"]);
  });

  it("resume cursor tracks numeric content ids, not control `c-` ids", async () => {
    const heartbeat: Frame = {
      id: "c-9",
      event: "heartbeat",
      data: { runId: "run-1" },
    };
    const http = new FakeHttp([
      severed(content("5", "a"), heartbeat),
      clean(content("6", "b"), FINISH),
    ]);
    expect(await deltas(http, FAST)).toEqual(["a", "b"]);
    expect(http.lastEventIds).toEqual([null, "5"]); // "c-9" is not a cursor
  });

  it("429 readiness → backs off and attaches, never surfaced to caller", async () => {
    const http = new FakeHttp([
      rateLimited(0),
      rateLimited(0),
      clean(content("1", "a"), FINISH),
    ]);
    expect(await deltas(http, FAST)).toEqual(["a"]);
    expect(http.streamCalls).toBe(3); // two 429s + one live attach
  });

  it("exhausts reconnects with no progress → throws", async () => {
    const http = new FakeHttp([severed(), severed(), severed(), severed()]);
    await expect(
      deltas(http, { backoffMs: 1, maxReconnects: 2 }),
    ).rejects.toThrow();
    expect(http.streamCalls).toBe(3); // initial + maxReconnects, then give up
  });

  it("forward progress resets the reconnect budget", async () => {
    // Each attach delivers one new event then drops; progress keeps it alive
    // well past maxReconnects until the turn finally completes.
    const http = new FakeHttp([
      severed(content("1", "a")),
      severed(content("2", "b")),
      severed(content("3", "c")),
      clean(content("4", "d"), FINISH),
    ]);
    expect(await deltas(http, { backoffMs: 1, maxReconnects: 1 })).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
    expect(http.streamCalls).toBe(4);
  });
});
