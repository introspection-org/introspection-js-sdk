/**
 * Tests for the OpenClaw → OTel GenAI semconv converters in
 * `@introspection-sdk/introspection-openclaw/src/util.ts`.
 *
 * The plugin itself is loaded by the OpenClaw gateway and doesn't initiate
 * HTTP under the test's control, so Polly doesn't apply here — these are
 * pure unit tests of the converter functions.
 */

import { describe, it, expect } from "vitest";
import {
  convertInputMessages,
  convertOutputMessages,
} from "../../packages/introspection-openclaw/src/util";

describe("convertInputMessages", () => {
  it("maps user/assistant/toolResult roles to user/assistant/tool", () => {
    const result = convertInputMessages(
      [
        { role: "user", content: "hi" },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "lookup",
              arguments: { q: "weather" },
            },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "tool_1",
          toolName: "lookup",
          content: [{ type: "text", text: "sunny" }],
        },
      ],
      undefined,
    );

    expect(result).toEqual([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
      {
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            id: "tool_1",
            name: "lookup",
            arguments: { q: "weather" },
          },
        ],
      },
      {
        role: "tool",
        name: "lookup",
        parts: [
          { type: "tool_call_response", id: "tool_1", response: "sunny" },
        ],
      },
    ]);
  });

  it("appends the current user prompt as a final user message", () => {
    const result = convertInputMessages([], "What's next?");
    expect(result).toEqual([
      { role: "user", parts: [{ type: "text", content: "What's next?" }] },
    ]);
  });

  it("flattens thinking blocks into text parts", () => {
    const result = convertInputMessages(
      [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "weighing options" },
            { type: "text", text: "Here's my answer." },
          ],
        },
      ],
      undefined,
    );

    expect(result[0]?.parts).toEqual([
      { type: "text", content: "weighing options" },
      { type: "text", content: "Here's my answer." },
    ]);
  });

  it("supports the legacy `input` field on tool_use blocks", () => {
    const result = convertInputMessages(
      [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "tool_1",
              name: "lookup",
              input: { legacy: true },
            },
          ],
        },
      ],
      undefined,
    );

    expect(result[0]?.parts).toEqual([
      {
        type: "tool_call",
        id: "tool_1",
        name: "lookup",
        arguments: { legacy: true },
      },
    ]);
  });

  it("ignores malformed history entries", () => {
    const result = convertInputMessages(
      [null, undefined, "string", { role: "unknown", content: "x" }],
      undefined,
    );
    expect(result).toEqual([]);
  });
});

describe("convertOutputMessages", () => {
  it("converts a structured assistant response", () => {
    const result = convertOutputMessages({
      role: "assistant",
      content: [{ type: "text", text: "Hello!" }],
      stopReason: "end_turn",
    });
    expect(result).toEqual([
      {
        role: "assistant",
        parts: [{ type: "text", content: "Hello!" }],
        finish_reason: "end_turn",
      },
    ]);
  });

  it("wraps a bare-string response in a text part", () => {
    const result = convertOutputMessages("plain string");
    expect(result).toEqual([
      {
        role: "assistant",
        parts: [{ type: "text", content: "plain string" }],
      },
    ]);
  });

  it("returns an empty array for unsupported shapes", () => {
    expect(convertOutputMessages(undefined)).toEqual([]);
    expect(convertOutputMessages(null)).toEqual([]);
    expect(convertOutputMessages(42)).toEqual([]);
  });

  it("includes tool_use blocks as tool_call parts in output", () => {
    const result = convertOutputMessages({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "tool_1",
          name: "lookup",
          arguments: { q: "x" },
        },
      ],
      stopReason: "tool_use",
    });

    expect(result[0]?.parts).toEqual([
      {
        type: "tool_call",
        id: "tool_1",
        name: "lookup",
        arguments: { q: "x" },
      },
    ]);
    expect(result[0]?.finish_reason).toBe("tool_use");
  });
});
