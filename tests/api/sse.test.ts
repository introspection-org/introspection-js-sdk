import { describe, expect, it } from "vitest";
import { parseSse } from "@introspection-sdk/introspection-node";

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
  for await (const ev of parseSse(res)) {
    events.push(ev);
  }
  return events;
}

describe("parseSse", () => {
  it("parses a single event with data", async () => {
    const events = await collect(textResponse("data: hello\n\n"));
    expect(events).toEqual([{ event: "message", data: "hello" }]);
  });

  it("parses named events", async () => {
    const events = await collect(textResponse("event: text\ndata: world\n\n"));
    expect(events).toEqual([{ event: "text", data: "world" }]);
  });

  it("parses multiple events", async () => {
    const events = await collect(
      textResponse("data: first\n\nevent: done\ndata: second\n\n"),
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ event: "message", data: "first" });
    expect(events[1]).toEqual({ event: "done", data: "second" });
  });

  it("handles multi-line data", async () => {
    const events = await collect(
      textResponse("data: line1\ndata: line2\ndata: line3\n\n"),
    );
    expect(events).toEqual([{ event: "message", data: "line1\nline2\nline3" }]);
  });

  it("ignores comment lines", async () => {
    const events = await collect(
      textResponse(": this is a comment\ndata: actual\n\n"),
    );
    expect(events).toEqual([{ event: "message", data: "actual" }]);
  });

  it("includes id field when present", async () => {
    const events = await collect(textResponse("id: 42\ndata: test\n\n"));
    expect(events).toEqual([{ event: "message", data: "test", id: "42" }]);
  });

  it("includes retry field when present and numeric", async () => {
    const events = await collect(textResponse("retry: 5000\ndata: test\n\n"));
    expect(events).toEqual([{ event: "message", data: "test", retry: 5000 }]);
  });

  it("ignores non-numeric retry values", async () => {
    const events = await collect(textResponse("retry: abc\ndata: test\n\n"));
    expect(events).toEqual([{ event: "message", data: "test" }]);
  });

  it("flushes final event when stream ends after a blank line", async () => {
    const events = await collect(textResponse("data: trailing\n"));
    expect(events).toEqual([{ event: "message", data: "trailing" }]);
  });

  it("resets event name to message after each event", async () => {
    const events = await collect(
      textResponse("event: custom\ndata: one\n\ndata: two\n\n"),
    );
    expect(events[0].event).toBe("custom");
    expect(events[1].event).toBe("message");
  });

  it("returns empty iterable for response with no body", async () => {
    const res = { body: null } as unknown as Response;
    const events = await collect(res);
    expect(events).toEqual([]);
  });

  it("handles \\r\\n line endings", async () => {
    const events = await collect(textResponse("data: crlf\r\n\r\n"));
    expect(events).toEqual([{ event: "message", data: "crlf" }]);
  });

  it("skips empty events (blank line with no prior fields)", async () => {
    const events = await collect(textResponse("\n\ndata: real\n\n"));
    expect(events).toEqual([{ event: "message", data: "real" }]);
  });

  it("handles chunked delivery", async () => {
    const encoder = new TextEncoder();
    const chunks = ["data: ch", "unked\n\n"];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    const events = await collect(new Response(stream));
    expect(events).toEqual([{ event: "message", data: "chunked" }]);
  });
});
