import { describe, it, expect } from "vitest";
import { convertClaudeResponseToOutputMessages } from "../../packages/introspection-node/src/converters/claude";

describe("convertClaudeResponseToOutputMessages", () => {
  it("should convert thinking blocks to thinking parts with content and signature", () => {
    const content = [
      {
        type: "thinking",
        thinking: "Let me work through this step by step...",
        signature: "ErUBCkEYs123",
      },
      { type: "text", text: "The answer is 42." },
    ];

    const result = convertClaudeResponseToOutputMessages(content);

    expect(JSON.stringify(result)).toBe(
      JSON.stringify([
        {
          role: "assistant",
          parts: [
            {
              type: "thinking",
              content: "Let me work through this step by step...",
              signature: "ErUBCkEYs123",
              provider_name: "anthropic",
            },
            { type: "text", content: "The answer is 42." },
          ],
        },
      ]),
    );
  });

  it("should convert thinking blocks without signature", () => {
    const content = [
      { type: "thinking", thinking: "Reasoning about the problem..." },
      { type: "text", text: "Done." },
    ];

    const result = convertClaudeResponseToOutputMessages(content);

    expect(JSON.stringify(result)).toBe(
      JSON.stringify([
        {
          role: "assistant",
          parts: [
            {
              type: "thinking",
              content: "Reasoning about the problem...",
              provider_name: "anthropic",
            },
            { type: "text", content: "Done." },
          ],
        },
      ]),
    );
  });

  it("should handle mixed thinking, text, and tool_use blocks", () => {
    const content = [
      { type: "thinking", thinking: "I need to search...", signature: "sig1" },
      {
        type: "tool_use",
        id: "tool_1",
        name: "search",
        input: { q: "test" },
      },
    ];

    const result = convertClaudeResponseToOutputMessages(content);

    expect(JSON.stringify(result)).toBe(
      JSON.stringify([
        {
          role: "assistant",
          parts: [
            {
              type: "thinking",
              content: "I need to search...",
              signature: "sig1",
              provider_name: "anthropic",
            },
            {
              type: "tool_call",
              id: "tool_1",
              name: "search",
              arguments: { q: "test" },
            },
          ],
        },
      ]),
    );
  });
});
