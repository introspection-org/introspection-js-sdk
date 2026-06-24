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
