import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  EventType,
  HttpClient,
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
      expect(srv.lastEventIds).toEqual([null, "2"]);
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
