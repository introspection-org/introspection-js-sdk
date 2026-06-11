/**
 * Unit tests for the pi ↔ semconv converters.
 *
 * No API keys, no OTel runtime — just validates the JSON shapes emitted on
 * `gen_ai.input.messages` / `gen_ai.output.messages` round-trip back to
 * pi-ai messages without losing the fields callers depend on.
 */

import { describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  Message,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import {
  assistantToOutputMessages,
  inputMessagesToMessages,
  messagesToInputMessages,
  systemPromptToInstructions,
} from "../../packages/introspection-pi/src/convert";

function userMessage(text: string): UserMessage {
  return { role: "user", content: text, timestamp: 0 };
}

function assistantMessage(
  partial: Partial<AssistantMessage> & Pick<AssistantMessage, "content">,
): AssistantMessage {
  return {
    role: "assistant",
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 0,
    ...partial,
  };
}

describe("messagesToInputMessages", () => {
  it("encodes a user prompt as a single text part", () => {
    const inputs = messagesToInputMessages([userMessage("Inspect the repo")]);
    expect(inputs).toEqual([
      { role: "user", parts: [{ type: "text", content: "Inspect the repo" }] },
    ]);
  });

  it("encodes assistant text + thinking + toolCall blocks", () => {
    const message = assistantMessage({
      content: [
        { type: "text", text: "Let me look.", textSignature: "sig-1" },
        {
          type: "thinking",
          thinking: "thinking out loud",
          thinkingSignature: "thinking-sig",
        },
        {
          type: "toolCall",
          id: "call-1",
          name: "shell",
          arguments: { cmd: "ls" },
        },
      ],
    });
    const inputs = messagesToInputMessages([message]);
    expect(inputs[0]?.parts).toEqual([
      { type: "text", content: "Let me look.", text_signature: "sig-1" },
      {
        type: "thinking",
        content: "thinking out loud",
        signature: "thinking-sig",
      },
      {
        type: "tool_call",
        id: "call-1",
        name: "shell",
        arguments: { cmd: "ls" },
      },
    ]);
  });

  it("encodes toolResult into a tool message with response field", () => {
    const message: ToolResultMessage = {
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "shell",
      content: [{ type: "text", text: "ok" }],
      isError: false,
      timestamp: 0,
    };
    const inputs = messagesToInputMessages([message]);
    expect(inputs).toEqual([
      {
        role: "tool",
        name: "shell",
        parts: [
          {
            type: "tool_call_response",
            id: "call-1",
            name: "shell",
            response: "ok",
          },
        ],
      },
    ]);
  });
});

describe("assistantToOutputMessages", () => {
  it("preserves provider / model / response_id / finish_reason", () => {
    const out = assistantToOutputMessages(
      assistantMessage({
        content: [{ type: "text", text: "Done." }],
        responseId: "resp_pi_123",
        stopReason: "stop",
      }),
    );
    expect(out).toEqual([
      {
        role: "assistant",
        parts: [{ type: "text", content: "Done." }],
        finish_reason: "stop",
        api: "anthropic-messages",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        response_id: "resp_pi_123",
      },
    ]);
  });
});

describe("systemPromptToInstructions", () => {
  it("wraps a system prompt as a single text part", () => {
    expect(systemPromptToInstructions("You are helpful.")).toEqual([
      { type: "text", content: "You are helpful." },
    ]);
  });
});

describe("inputMessagesToMessages (semconv → pi-ai)", () => {
  it("round-trips user / assistant text / toolCall / toolResult", () => {
    const original: Message[] = [
      userMessage("hello"),
      assistantMessage({
        content: [
          { type: "text", text: "Looking now." },
          {
            type: "toolCall",
            id: "call-1",
            name: "shell",
            arguments: { cmd: "ls" },
          },
        ],
      }),
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "shell",
        content: [{ type: "text", text: "ok" }],
        isError: false,
        timestamp: 0,
      },
    ];

    const replayed = inputMessagesToMessages(messagesToInputMessages(original));

    expect(replayed.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    const assistant = replayed[1] as AssistantMessage;
    expect(assistant.content).toEqual([
      { type: "text", text: "Looking now." },
      {
        type: "toolCall",
        id: "call-1",
        name: "shell",
        arguments: { cmd: "ls" },
      },
    ]);
    const tool = replayed[2] as ToolResultMessage;
    expect(tool.toolCallId).toBe("call-1");
    expect(tool.toolName).toBe("shell");
  });

  it("drops orphaned tool results with no matching assistant tool call", () => {
    const replayed = inputMessagesToMessages([
      { role: "user", parts: [{ type: "text", content: "hi" }] },
      {
        role: "tool",
        parts: [
          {
            type: "tool_call_response",
            id: "ghost",
            name: "shell",
            response: "stale",
          },
        ],
      },
    ]);

    expect(replayed.map((m) => m.role)).toEqual(["user"]);
  });

  it("strips trailing assistant tool calls that never received a result", () => {
    const replayed = inputMessagesToMessages([
      {
        role: "assistant",
        parts: [
          { type: "text", content: "About to call." },
          {
            type: "tool_call",
            id: "call-1",
            name: "shell",
            arguments: { cmd: "ls" },
          },
        ],
      },
    ]);

    expect(replayed).toHaveLength(1);
    const assistant = replayed[0] as AssistantMessage;
    expect(assistant.content).toEqual([
      { type: "text", text: "About to call." },
    ]);
  });
});

describe("compaction summaries", () => {
  const SUMMARY = "Use pnpm and keep citations.";
  const RENDERED_COMPACTION_TEXT = `The conversation history before this point was compacted into the following summary:

<summary>
${SUMMARY}
</summary>`;

  it("encodes a Pi-rendered compaction message as a compaction part", () => {
    const inputs = messagesToInputMessages([
      userMessage(RENDERED_COMPACTION_TEXT),
    ]);
    expect(inputs).toEqual([
      { role: "user", parts: [{ type: "compaction", content: SUMMARY }] },
    ]);
  });

  it("matches pi's real convertToLlm rendering (cross-repo contract)", () => {
    // The wire contract: pi renders a compactionSummary message into user
    // text via convertToLlm; the converter must recognize exactly that
    // rendering. If pi rewords its preamble, this test fails — update the
    // mirrored COMPACTION_SUMMARY_* constants in convert.ts to match.
    const rendered = convertToLlm([
      {
        role: "compactionSummary",
        summary: SUMMARY,
        tokensBefore: 12_345,
        timestamp: 0,
      },
    ]);
    const inputs = messagesToInputMessages(rendered as Message[]);
    expect(inputs).toEqual([
      { role: "user", parts: [{ type: "compaction", content: SUMMARY }] },
    ]);
  });

  it("re-renders compaction parts byte-identically on hydration", () => {
    const replayed = inputMessagesToMessages([
      { role: "user", parts: [{ type: "compaction", content: SUMMARY }] },
    ]);
    expect(replayed).toEqual([
      { role: "user", content: RENDERED_COMPACTION_TEXT, timestamp: 0 },
    ]);
  });

  it("round-trips pi-rendered compaction text through both converters", () => {
    const replayed = inputMessagesToMessages(
      messagesToInputMessages([userMessage(RENDERED_COMPACTION_TEXT)]),
    );
    expect(replayed).toEqual([
      { role: "user", content: RENDERED_COMPACTION_TEXT, timestamp: 0 },
    ]);
  });

  it("leaves a user message merely quoting the preamble as a text part", () => {
    const quoting = `What does this mean?\n\n${RENDERED_COMPACTION_TEXT}`;
    const inputs = messagesToInputMessages([userMessage(quoting)]);
    expect(inputs).toEqual([
      { role: "user", parts: [{ type: "text", content: quoting }] },
    ]);
  });
});

describe("compaction summaries — structural detection via compactionSummaries", () => {
  const SUMMARY = "Use pnpm and keep citations.";

  it("detects a compaction message via a session-known summary", () => {
    const rendered = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${SUMMARY}\n</summary>`;
    const inputs = messagesToInputMessages([userMessage(rendered)], {
      compactionSummaries: [SUMMARY],
    });
    expect(inputs).toEqual([
      { role: "user", parts: [{ type: "compaction", content: SUMMARY }] },
    ]);
  });

  it("survives a reworded wrapper when the summary is session-known", () => {
    // Simulates pi (or a custom-compaction extension) changing the prose
    // around the summary: the prefix fallback would miss this, the
    // structural path must not.
    const reworded = `Everything earlier was squashed. Summary follows:\n${SUMMARY}\nCarry on.`;
    const inputs = messagesToInputMessages([userMessage(reworded)], {
      compactionSummaries: [SUMMARY],
    });
    expect(inputs).toEqual([
      { role: "user", parts: [{ type: "compaction", content: SUMMARY }] },
    ]);
  });

  it("ignores empty session summaries and ordinary user messages", () => {
    const inputs = messagesToInputMessages([userMessage("just a question")], {
      compactionSummaries: ["", SUMMARY],
    });
    expect(inputs).toEqual([
      { role: "user", parts: [{ type: "text", content: "just a question" }] },
    ]);
  });

  it("falls back to prefix detection when no summaries are supplied", () => {
    const rendered = `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${SUMMARY}\n</summary>`;
    const inputs = messagesToInputMessages([userMessage(rendered)], {
      compactionSummaries: [],
    });
    expect(inputs).toEqual([
      { role: "user", parts: [{ type: "compaction", content: SUMMARY }] },
    ]);
  });
});
