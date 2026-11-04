import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  EventType,
  HttpClient,
  StreamIncompleteError,
  TaskRunsApi,
} from "@introspection-sdk/introspection-node";
import type { AGUIEvent } from "@introspection-sdk/types";

/**
 * Real end-to-end resume test: a genuine HTTP server streams SSE, then
 * **abruptly destroys the socket mid-stream** (a real connection drop, not a
 * mocked exception). The SDK reconnects over real `fetch`, sending
 * `Last-Event-ID`, and we assert the consumer sees a gap-free `AGUIEvent`
 * sequence plus the opt-in `introspection.reconnect` CUSTOM event.
 */

function frame(id: string, delta: string): string {
  return (
    `id: ${id}\nevent: ag_ui\n` +
    `data: ${JSON.stringify({
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "m",
      delta,
    })}\n\n`
  );
}

const FINISH =
  `id: c-0\nevent: ag_ui\n` +
  `data: ${JSON.stringify({
    type: EventType.RUN_FINISHED,
    threadId: "t",
    runId: "run-1",
  })}\n\n`;

interface Harness {
  url: string;
  /** `Last-Event-ID` header seen on each attach (null when absent). */
  lastEventIds: (string | null)[];
  close: () => Promise<void>;
}

/**
 * Start a server that, on the first attach, streams two frames then RSTs the
 * socket; on the reconnect, streams the rest and closes cleanly.
 */
async function startDroppingServer(): Promise<Harness> {
  const lastEventIds: (string | null)[] = [];
  let attach = 0;
  const server: Server = createServer((req, res) => {
    lastEventIds.push((req.headers["last-event-id"] as string) ?? null);
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (attach++ === 0) {
      // Deliver frames 1 & 2, then abruptly drop once they've flushed.
      res.write(frame("1", "a") + frame("2", "b"), () => {
        res.socket?.destroy(); // RST → the client's body read errors
      });
    } else {
      res.write(frame("3", "c") + FINISH);
      res.end(); // clean EOF = turn complete
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    lastEventIds,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

describe("resilient stream — real connection drop (integration)", () => {
  it("reconnects over real fetch and emits the introspection.reconnect CUSTOM event", async () => {
    const srv = await startDroppingServer();
    try {
      const http = new HttpClient({ apiUrl: srv.url, token: "test-token" });
      const api = new TaskRunsApi(http);

      const events: AGUIEvent[] = [];
      for await (const ev of api.stream("task-1", "run-1", {
        emitReconnectEvents: true,
        backoffMs: 1,
      })) {
        events.push(ev);
      }

      // Gap-free across the real mid-stream drop.
      const deltas = events
        .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
        .map((e) => (e as AGUIEvent & { delta?: string }).delta);
      expect(deltas).toEqual(["a", "b", "c"]);

      // The opt-in reconnect marker is surfaced as a CUSTOM AG-UI event.
      const reconnects = events.filter(
        (e): e is AGUIEvent & { name: string; value: unknown } =>
          e.type === EventType.CUSTOM &&
          (e as AGUIEvent & { name?: string }).name ===
            "introspection.reconnect",
      );
      expect(reconnects).toHaveLength(1);
      expect(reconnects[0].value).toMatchObject({ reason: "severed" });

      // The reconnect actually re-attached with the last content-frame id.
      expect(srv.lastEventIds).toEqual(["0", "2"]);
    } finally {
      await srv.close();
    }
  });

  it("stays transparent (no CUSTOM event) when emitReconnectEvents is off", async () => {
    const srv = await startDroppingServer();
    try {
      const http = new HttpClient({ apiUrl: srv.url, token: "test-token" });
      const api = new TaskRunsApi(http);

      const events: AGUIEvent[] = [];
      for await (const ev of api.stream("task-1", "run-1", { backoffMs: 1 })) {
        events.push(ev);
      }

      expect(
        events
          .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
          .map((e) => (e as AGUIEvent & { delta?: string }).delta),
      ).toEqual(["a", "b", "c"]); // still gap-free
      expect(events.some((e) => e.type === EventType.CUSTOM)).toBe(false);
    } finally {
      await srv.close();
    }
  });
});

/** What the scripted server does on one attach. */
type Attach =
  | { status: number } // refuse with this HTTP status and a JSON error body
  | { drop: string } // stream these frames, then RST the socket
  | { end: string }; // stream these frames, then close cleanly

/**
 * Start a server that answers the n-th attach with `script[n]`, so each
 * recovery branch runs on a real response converted by the real `HttpClient`.
 */
async function startScriptedServer(script: Attach[]): Promise<Harness> {
  const lastEventIds: (string | null)[] = [];
  const server: Server = createServer((req, res) => {
    lastEventIds.push((req.headers["last-event-id"] as string) ?? null);
    const step = script[lastEventIds.length - 1] ?? { status: 500 };
    if ("status" in step) {
      res.writeHead(step.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: `HTTP ${step.status}` } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    if ("drop" in step) {
      res.write(step.drop, () => res.socket?.destroy());
    } else {
      res.end(step.end);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    lastEventIds,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      ),
  };
}

async function collect(
  srv: Harness,
  opts: { signal?: AbortSignal } = {},
): Promise<AGUIEvent[]> {
  const api = new TaskRunsApi(
    new HttpClient({ apiUrl: srv.url, token: "test-token" }),
  );
  const events: AGUIEvent[] = [];
  for await (const ev of api.stream("task-1", "run-1", {
    ...opts,
    emitReconnectEvents: true,
    backoffMs: 1,
  })) {
    events.push(ev);
  }
  return events;
}

describe("resilient stream — real connect errors (integration)", () => {
  it("410 → throws StreamIncompleteError without reconnecting", async () => {
    const srv = await startScriptedServer([{ status: 410 }, { end: FINISH }]);
    try {
      await expect(collect(srv)).rejects.toBeInstanceOf(StreamIncompleteError);
      expect(srv.lastEventIds).toEqual(["0"]);
    } finally {
      await srv.close();
    }
  });

  it("other 4xx → rethrows the API error without reconnecting", async () => {
    const srv = await startScriptedServer([{ status: 403 }, { end: FINISH }]);
    try {
      await expect(collect(srv)).rejects.toMatchObject({ status: 403 });
      expect(srv.lastEventIds).toEqual(["0"]);
    } finally {
      await srv.close();
    }
  });

  it("an already-aborted signal throws before attaching", async () => {
    const srv = await startScriptedServer([{ end: FINISH }]);
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        collect(srv, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(srv.lastEventIds).toEqual([]);
    } finally {
      await srv.close();
    }
  });

  it("emits one reconnect event per recovery, naming its reason", async () => {
    const srv = await startScriptedServer([
      { drop: frame("1", "a") },
      { status: 503 },
      { end: frame("2", "b") + FINISH },
    ]);
    try {
      const events = await collect(srv);
      expect(
        events
          .filter((e) => e.type === EventType.TEXT_MESSAGE_CONTENT)
          .map((e) => (e as AGUIEvent & { delta?: string }).delta),
      ).toEqual(["a", "b"]);
      expect(
        events
          .filter(
            (e) =>
              (e as AGUIEvent & { name?: string }).name ===
              "introspection.reconnect",
          )
          .map((e) => (e as AGUIEvent & { value?: unknown }).value),
      ).toEqual([
        // The severed attach delivered new content, so its budget resets to 0.
        { reason: "severed", attempt: 0, lastEventId: "1" },
        {
          reason: "connect_error",
          attempt: 1,
          lastEventId: "1",
          phase: null,
          retryAfterMs: null,
        },
      ]);
      expect(srv.lastEventIds).toEqual(["0", "1", "1"]);
    } finally {
      await srv.close();
    }
  });
});
