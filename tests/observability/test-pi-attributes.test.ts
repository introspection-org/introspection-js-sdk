/**
 * Unit tests for the chat / execute_tool attribute builders in
 * `@introspection-sdk/introspection-pi`.
 *
 * Validates the GenAI semconv attribute set the worker emits per chat
 * span and per tool span, including the size-cap fallback for
 * `gen_ai.system_instructions` and `gen_ai.tool.definitions`.
 */

import { describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  Context,
  Model,
  Tool,
} from "@earendil-works/pi-ai";
import {
  chatRequestAttributes,
  chatResponseAttributes,
  executeToolAttributes,
  executeToolResultAttribute,
  type AgentMeta,
} from "../../packages/introspection-pi/src/attributes";

const META: AgentMeta = {
  conversationId: "conv_123",
  agentId: "agent-1",
  agentName: "Test Agent",
};

const MODEL: Model<"anthropic-messages"> = {
  id: "claude-sonnet-4-6",
  name: "Claude Sonnet",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://api.anthropic.com",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8192,
};

function ctx(partial: Partial<Context> = {}): Context {
  return {
    messages: [{ role: "user", content: "Inspect the repo", timestamp: 0 }],
    ...partial,
  };
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

describe("chatRequestAttributes", () => {
  it("emits the documented identification attributes", () => {
    const attrs = chatRequestAttributes(MODEL, ctx(), META, {
      streamOptions: {
        temperature: 0.2,
        maxTokens: 1024,
        reasoning: "high",
      },
    });
    expect(attrs).toMatchObject({
      "gen_ai.conversation.id": "conv_123",
      "gen_ai.agent.id": "agent-1",
      "gen_ai.agent.name": "Test Agent",
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.request.model": "claude-sonnet-4-6",
      "gen_ai.request.stream": true,
      "gen_ai.request.temperature": 0.2,
      "gen_ai.request.max_tokens": 1024,
      "gen_ai.request.reasoning.level": "high",
    });
  });

  it("serializes input messages, system instructions, and tool definitions", () => {
    const attrs = chatRequestAttributes(
      MODEL,
      ctx({
        systemPrompt: "Be concise.",
        tools: [
          {
            name: "shell",
            description: "Run a shell command",
            parameters: {
              type: "object",
              properties: { cmd: { type: "string" } },
            } as Tool["parameters"],
          },
        ],
      }),
      META,
    );

    expect(JSON.parse(String(attrs["gen_ai.input.messages"]))).toEqual([
      { role: "user", parts: [{ type: "text", content: "Inspect the repo" }] },
    ]);
    expect(JSON.parse(String(attrs["gen_ai.system_instructions"]))).toEqual([
      { type: "text", content: "Be concise." },
    ]);
    const toolDefs = JSON.parse(String(attrs["gen_ai.tool.definitions"]));
    expect(toolDefs[0]).toMatchObject({
      type: "function",
      name: "shell",
      description: "Run a shell command",
    });
  });

  it("omits gen_ai.system_instructions when no system prompt is set", () => {
    const attrs = chatRequestAttributes(MODEL, ctx(), META);
    expect(attrs["gen_ai.system_instructions"]).toBeUndefined();
  });

  it("marks requests with compacted context", () => {
    const attrs = chatRequestAttributes(
      MODEL,
      ctx({
        messages: [
          {
            role: "user",
            content: `The conversation history before this point was compacted into the following summary:

<summary>
Earlier context.
</summary>`,
            timestamp: 0,
          },
        ],
      }),
      META,
    );

    expect(attrs["gen_ai.conversation.compacted"]).toBe(true);
    expect(JSON.parse(String(attrs["gen_ai.input.messages"]))).toEqual([
      {
        role: "user",
        parts: [{ type: "compaction", content: "Earlier context." }],
      },
    ]);
  });

  it("falls back to the compact tool list when the detailed payload exceeds the size cap", () => {
    const bigDescription = "x".repeat(70_000);
    const attrs = chatRequestAttributes(
      MODEL,
      ctx({
        tools: [
          {
            name: "shell",
            description: bigDescription,
            parameters: {
              type: "object",
              properties: {},
            } as Tool["parameters"],
          },
        ],
      }),
      META,
    );
    const compact = JSON.parse(String(attrs["gen_ai.tool.definitions"]));
    expect(compact).toEqual([{ type: "function", name: "shell" }]);
  });
});

describe("chatResponseAttributes", () => {
  it("emits usage / finish reason / output messages", () => {
    const attrs = chatResponseAttributes(
      assistantMessage({
        content: [{ type: "text", text: "Done." }],
        usage: {
          input: 321,
          output: 12,
          reasoningOutputTokens: 7,
          cacheRead: 34,
          cacheWrite: 0,
          totalTokens: 367,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 0.0042,
          },
        },
        responseId: "resp_pi_123",
      }),
    );

    expect(attrs["gen_ai.usage.input_tokens"]).toBe(321);
    expect(attrs["gen_ai.usage.output_tokens"]).toBe(12);
    expect(attrs["gen_ai.usage.reasoning.output_tokens"]).toBe(7);
    expect(attrs["gen_ai.usage.cache_read.input_tokens"]).toBe(34);
    // cache_creation should be absent when 0
    expect(attrs["gen_ai.usage.cache_creation.input_tokens"]).toBeUndefined();
    expect(attrs["gen_ai.cost.usd"]).toBe(0.0042);
    expect(attrs["gen_ai.response.id"]).toBe("resp_pi_123");
    expect(attrs["gen_ai.response.model"]).toBe("claude-sonnet-4-6");
    expect(attrs["gen_ai.response.finish_reasons"]).toEqual(["stop"]);

    const outputs = JSON.parse(String(attrs["gen_ai.output.messages"]));
    expect(outputs[0]).toMatchObject({
      role: "assistant",
      finish_reason: "stop",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      response_id: "resp_pi_123",
      parts: [{ type: "text", content: "Done." }],
    });
  });
});

describe("executeToolAttributes / executeToolResultAttribute", () => {
  it("emits the GenAI tool-call attribute set", () => {
    const attrs = executeToolAttributes("shell", "call-1", { cmd: "ls" }, META);
    expect(attrs).toMatchObject({
      "gen_ai.conversation.id": "conv_123",
      "gen_ai.agent.id": "agent-1",
      "gen_ai.agent.name": "Test Agent",
      "gen_ai.operation.name": "execute_tool",
      "gen_ai.tool.name": "shell",
      "gen_ai.tool.type": "function",
      "gen_ai.tool.call.id": "call-1",
    });
    expect(JSON.parse(String(attrs["gen_ai.tool.call.arguments"]))).toEqual({
      cmd: "ls",
    });
  });

  it("returns no result attribute when the tool returned undefined", () => {
    expect(executeToolResultAttribute(undefined)).toEqual({});
  });

  it("stringifies non-string tool results", () => {
    expect(executeToolResultAttribute({ stdout: "ok" })).toEqual({
      "gen_ai.tool.call.result": '{"stdout":"ok"}',
    });
    expect(executeToolResultAttribute("plain text")).toEqual({
      "gen_ai.tool.call.result": "plain text",
    });
  });
});
