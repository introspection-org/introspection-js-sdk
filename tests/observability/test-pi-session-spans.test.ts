/**
 * Unit tests for rendering a Pi session file as the GenAI span list the
 * platform's conversation export returns.
 */

import { describe, expect, it } from "vitest";

import type { Message } from "@earendil-works/pi-ai";
import { convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { foldSpans } from "@introspection-sdk/http";
import {
  messagesToInputMessages,
  piSessionToSpans,
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
    const list = piSessionToSpans(
      sessionFile([user, call, result, answer]),
      "conv-1",
    );

    // The envelope of a complete, single-page conversation export.
    expect({ ...list, data: undefined }).toEqual({
      object: "list",
      data: undefined,
      first_id: "span-1",
      last_id: "span-3",
      has_more: false,
      next: null,
    });
    expect(list.data.map((span) => [span.name, span.start_time])).toEqual([
      ["chat claude-opus-5-5", "1970-01-01T00:00:02.000Z"],
      ["execute_tool read", "1970-01-01T00:00:03.000Z"],
      ["chat claude-opus-5-5", "1970-01-01T00:00:04.000Z"],
    ]);

    const [first, tool, second] = list.data;
    const genAi = first.attributes.gen_ai;
    expect(genAi?.conversation).toEqual({ id: "conv-1" });
    expect(genAi?.provider).toEqual({ name: "anthropic" });
    expect(genAi?.response?.model).toBe("claude-opus-5-5");
    // Semconv input tokens include the cached ones.
    expect(genAi?.usage).toMatchObject({
      input_tokens: 100,
      output_tokens: 10,
      cache_read: { input_tokens: 30 },
    });
    expect(genAi?.cost).toEqual({ usd: 0.01 });
    expect(genAi?.input?.messages).toEqual([
      { role: "user", parts: [{ type: "text", content: "Read the file" }] },
    ]);
    expect(
      genAi?.output?.messages?.[0]?.parts.map((part) => part.type),
    ).toEqual(["reasoning", "text", "tool_call"]);

    expect(tool.status).toEqual({ code: "Error" });
    expect(tool.attributes.gen_ai?.tool?.call).toEqual({
      id: "c1",
      arguments: JSON.stringify({ path: "a" }),
      result: JSON.stringify({
        content: [{ type: "text", text: "no such file" }],
      }),
    });

    expect(
      second.attributes.gen_ai?.input?.messages?.map((message) => message.role),
    ).toEqual(["user", "assistant", "tool"]);
  });

  it("ends every span, so a finished tool call does not read as running", () => {
    const list = piSessionToSpans(sessionFile([user, call, result]), "conv-1");

    for (const span of list.data) {
      expect(span.end_time).toBe(span.start_time);
      expect(span.duration_ns).toBe(0);
    }
    // Un-ended, foldSpans reads the execute_tool span as still running.
    expect(foldSpans([list.data[1]])).toEqual([
      expect.objectContaining({ kind: "tool", callId: "c1", status: "error" }),
    ]);
  });

  it("skips lines that are not session entries", () => {
    const file = ["not json", "5", sessionFile([user, answer]), ""].join("\n");

    expect(piSessionToSpans(file, "conv-1").data).toHaveLength(1);
  });

  it("never orders a span before the one it follows", () => {
    const list = piSessionToSpans(
      sessionFile([user, { ...answer, timestamp: 0 }, answer]),
      "conv-1",
    );

    const times = list.data.map((span) => Date.parse(span.start_time));
    expect(times[1]).toBeGreaterThan(times[0]);
  });

  it("renders the context a compaction left, not the history it replaced", () => {
    const summary = "Earlier: tried to read a.";
    const entry = (id: string, message: object) =>
      JSON.stringify({ type: "message", id, message });
    const kept = { role: "user", content: "Now list b", timestamp: 5000 };
    const system = (prompt: string) => ({
      role: "system",
      content: prompt,
      tools: [],
      timestamp: 500,
    });
    const spans = piSessionToSpans(
      [
        JSON.stringify({ type: "session", id: "s1" }),
        entry("e0", system("Be brief.")),
        entry("e1", user),
        entry("e2", call),
        entry("e3", result),
        entry("e4", answer),
        entry("e5", kept),
        JSON.stringify({
          type: "compaction",
          id: "e6",
          summary,
          firstKeptEntryId: "e5",
          systemMessage: system("Be brief."),
          timestamp: "1970-01-01T00:00:06.000Z",
        }),
        entry("e7", { ...answer, timestamp: 7000 }),
      ].join("\n"),
      "conv-1",
    ).data;

    const inputs = spans.map((span) => span.attributes.gen_ai?.input?.messages);
    // Calls made before the compaction still show the history they saw.
    expect(inputs[2]?.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "tool",
    ]);
    // The system prompt survives the compaction, as it does in a live run.
    expect(
      spans
        .filter((span) => span.name?.startsWith("chat"))
        .map((span) => span.attributes.gen_ai?.system_instructions),
    ).toEqual(Array(3).fill([{ type: "text", content: "Be brief." }]));
    expect(inputs.at(-1)).toEqual([
      { role: "user", parts: [{ type: "compaction", content: summary }] },
      { role: "user", parts: [{ type: "text", content: "Now list b" }] },
    ]);
    expect(spans.at(-1)?.attributes.gen_ai?.conversation?.compacted).toBe(true);
  });

  // Pi's own session writer and context builder are the oracle here, so the
  // rebuild in the renderer cannot drift from what Pi sends the model.
  it("matches the context Pi itself builds after a compaction", () => {
    const summary = "Earlier: tried to read a.";
    const session = SessionManager.inMemory();
    const append = (message: object) =>
      session.appendMessage(message as Message);
    for (const message of [user, call, result, answer]) append(message);
    const keptId = append({
      role: "user",
      content: "Now list b",
      timestamp: 5000,
    });
    append({ ...answer, timestamp: 6000 });
    session.appendCompaction(summary, keptId, 1000);
    append({ role: "user", content: "And c?", timestamp: 7000 });
    // What Pi would send for the next model call.
    const expected = messagesToInputMessages(
      convertToLlm(session.buildSessionContext().messages),
      { compactionSummaries: [summary] },
    );
    append({ ...answer, timestamp: 8000 });

    const file = [session.getHeader(), ...session.getEntries()]
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    const last = piSessionToSpans(file, "conv-1").data.at(-1);

    expect(expected[0]?.parts[0]?.type).toBe("compaction");
    expect(last?.attributes.gen_ai?.input?.messages).toEqual(expected);
  });
});
