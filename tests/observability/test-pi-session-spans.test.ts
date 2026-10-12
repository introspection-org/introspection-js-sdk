/**
 * Unit tests for rendering a Pi session file or event stream as the GenAI
 * span list the platform's conversation export returns.
 */

import { describe, expect, it } from "vitest";

import {
  parsePiFile,
  piFileToSpans,
} from "@introspection-sdk/introspection-pi";

const usage = {
  input: 60,
  output: 10,
  cacheRead: 30,
  cacheWrite: 10,
  totalTokens: 110,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
};

const user = { role: "user", content: "Read the file", timestamp: 1000 };
const call = {
  role: "assistant",
  provider: "anthropic",
  model: "claude-opus-5-5",
  api: "anthropic-messages",
  stopReason: "toolUse",
  usage,
  timestamp: 2000,
  content: [
    { type: "thinking", thinking: "I should read it." },
    { type: "text", text: "Reading." },
    { type: "toolCall", id: "c1", name: "read", arguments: { path: "a" } },
  ],
};
const result = {
  role: "toolResult",
  toolCallId: "c1",
  toolName: "read",
  content: [{ type: "text", text: "no such file" }],
  isError: true,
  timestamp: 3000,
};
const answer = {
  role: "assistant",
  provider: "anthropic",
  model: "claude-opus-5-5",
  api: "anthropic-messages",
  stopReason: "stop",
  usage,
  timestamp: 4000,
  content: [{ type: "text", text: "It is missing." }],
};

function sessionFile(messages: object[]): string {
  return [
    JSON.stringify({ type: "session", id: "s1" }),
    ...messages.map((message) => JSON.stringify({ type: "message", message })),
  ].join("\n");
}

describe("pi-session-spans", () => {
  it("renders a session as chat and execute_tool spans", () => {
    const list = piFileToSpans(
      parsePiFile(sessionFile([user, call, result, answer])),
      "conv-1",
    );

    expect(list.object).toBe("list");
    expect(list.data.map((span) => [span.name, span.start_time])).toEqual([
      ["chat claude-opus-5-5", "1970-01-01T00:00:02.000Z"],
      ["execute_tool read", "1970-01-01T00:00:03.000Z"],
      ["chat claude-opus-5-5", "1970-01-01T00:00:04.000Z"],
    ]);

    const [first, tool, second] = list.data;
    const genAi = first.attributes.gen_ai as Record<string, any>;
    expect(genAi.conversation).toEqual({ id: "conv-1" });
    expect(genAi.provider).toEqual({ name: "anthropic" });
    expect(genAi.response.model).toBe("claude-opus-5-5");
    // Semconv input tokens include the cached ones.
    expect(genAi.usage).toMatchObject({
      input_tokens: 100,
      output_tokens: 10,
      cache_read: { input_tokens: 30 },
    });
    expect(genAi.cost).toEqual({ usd: 0.01 });
    expect(genAi.input.messages).toEqual([
      { role: "user", parts: [{ type: "text", content: "Read the file" }] },
    ]);
    expect(
      genAi.output.messages[0].parts.map((part: { type: string }) => part.type),
    ).toEqual(["reasoning", "text", "tool_call"]);

    expect(tool.status).toEqual({ code: "Error" });
    expect((tool.attributes.gen_ai as Record<string, any>).tool.call.id).toBe(
      "c1",
    );

    const prompt = (second.attributes.gen_ai as Record<string, any>).input
      .messages;
    expect(prompt.map((message: { role: string }) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
  });

  it("reads the event stream and skips diagnostic lines", () => {
    const stream = [
      "npm warn something",
      JSON.stringify({ type: "message_start", message: user }),
      JSON.stringify({ type: "message_end", message: user }),
      JSON.stringify({ type: "message_end", message: answer }),
    ].join("\n");

    expect(parsePiFile(stream).messages).toEqual([user, answer]);
  });

  it("keeps messages no model call answered", () => {
    const list = piFileToSpans(parsePiFile(sessionFile([user])), "conv-1");

    expect(list.data).toHaveLength(1);
    const genAi = list.data[0].attributes.gen_ai as Record<string, any>;
    expect(genAi.input.messages).toHaveLength(1);
    expect(genAi.output).toBeUndefined();
  });

  it("never orders a span before the one it follows", () => {
    const list = piFileToSpans(
      parsePiFile(sessionFile([user, { ...answer, timestamp: 0 }, answer])),
      "conv-1",
    );

    const times = list.data.map((span) => Date.parse(span.start_time));
    expect(times[1]).toBeGreaterThan(times[0]);
  });

  it("marks a known compaction summary as a compaction part", () => {
    const summary = "Earlier: read a.txt.";
    const file = parsePiFile(
      [
        JSON.stringify({ type: "compaction", summary }),
        sessionFile([{ ...user, content: summary }, answer]),
      ].join("\n"),
    );

    expect(file.compactionSummaries).toEqual([summary]);
    const genAi = piFileToSpans(file, "conv-1").data[0].attributes
      .gen_ai as Record<string, any>;
    expect(genAi.input.messages[0].parts[0].type).toBe("compaction");
  });
});
