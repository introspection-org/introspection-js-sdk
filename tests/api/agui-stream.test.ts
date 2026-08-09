import { describe, expect, it } from "vitest";
import { EventType, parseAgUiEvents } from "@introspection-sdk/http";

function textResponse(text: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(stream);
}

async function collect(res: Response) {
  const events = [];
  for await (const ev of parseAgUiEvents(res)) {
    events.push(ev);
  }
  return events;
}

describe("parseAgUiEvents", () => {
  it("yields AG-UI events from ag_ui frames", async () => {
    const event = {
      type: EventType.TEXT_MESSAGE_CONTENT,
      messageId: "msg-1",
      delta: "hello",
    };

    const events = await collect(
      textResponse(`event: ag_ui\ndata: ${JSON.stringify(event)}\n\n`),
    );

    expect(events).toEqual([event]);
  });

  it("ignores transport frames", async () => {
    const event = {
      type: EventType.RUN_STARTED,
      threadId: "task-1",
      runId: "run-1",
    };

    const events = await collect(
      textResponse(
        `event: heartbeat\ndata: {}\n\nevent: ag_ui\ndata: ${JSON.stringify(
          event,
        )}\n\n`,
      ),
    );

    expect(events).toEqual([event]);
  });

  it("handles multi-line JSON data", async () => {
    const events = await collect(
      textResponse(
        'event: ag_ui\ndata: {"type":"TEXT_MESSAGE_CONTENT",\ndata: "messageId":"msg-1",\ndata: "delta":"hello"}\n\n',
      ),
    );

    expect(events).toEqual([
      {
        type: EventType.TEXT_MESSAGE_CONTENT,
        messageId: "msg-1",
        delta: "hello",
      },
    ]);
  });

  it("returns empty iterable for response with no body", async () => {
    const res = { body: null } as unknown as Response;
    expect(await collect(res)).toEqual([]);
  });

  it("rejects invalid AG-UI payloads", async () => {
    await expect(async () => {
      for await (const _ev of parseAgUiEvents(
        textResponse('event: ag_ui\ndata: {"type":"NOPE"}\n\n'),
      )) {
        // consume stream
      }
    }).rejects.toThrow();
  });
});

describe("parseAgUiEvents stream lifecycle", () => {
  it("cancels the response body when the consumer stops early", async () => {
    let cancelled = false;
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 3; i++) {
          controller.enqueue(
            encoder.encode(
              `event: ag_ui\ndata: ${JSON.stringify({
                type: EventType.TEXT_MESSAGE_CONTENT,
                messageId: "m1",
                delta: `chunk-${i}`,
              })}\n\n`,
            ),
          );
        }
        controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });

    // A UI that stops at the first answer. Without the `finally`, the reader
    // stayed locked and the connection open for the life of the process.
    for await (const _ev of parseAgUiEvents(new Response(body))) {
      break;
    }

    expect(cancelled).toBe(true);
  });

  it("discards a frame that has no terminating blank line", async () => {
    // Truncated mid-payload by a severed connection. Flushing it used to hand
    // the caller half a JSON document.
    const events = await collect(
      textResponse(
        `event: ag_ui\ndata: ${JSON.stringify({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId: "m1",
          delta: "complete",
        })}\n\nevent: ag_ui\ndata: {"type":"TEXT_MESSAGE_CO`,
      ),
    );
    expect(events).toHaveLength(1);
  });
});
