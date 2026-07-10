/**
 * Tests for the OpenClaw attribute-record builders in
 * `@introspection-sdk/introspection-openclaw/src/attributes.ts`.
 *
 * Verifies semconv-correct attribute names (the migration from
 * `gen_ai.usage.cache_read_input_tokens` → `cache_read.input_tokens` etc.),
 * size-cap fallbacks for `gen_ai.tool.definitions`, and that openclaw-only
 * keys (`openclaw.*`, `introspection.new_messages.*`) are still emitted.
 */

import { describe, it, expect } from "vitest";
import {
  agentEndAttributes,
  chatRequestAttributes,
  chatResponseAttributes,
  executeToolAttributes,
  executeToolResultAttributes,
  invokeAgentAttributes,
  toolResponseChatAttributes,
  usageAttributes,
} from "../../packages/introspection-openclaw/src/attributes";

const META = {
  agentId: "agent-1",
  agentName: "Test Agent",
  conversationId: "conv-1",
};

describe("invokeAgentAttributes", () => {
  it("emits the four GenAI agent attrs plus the openclaw session key", () => {
    expect(invokeAgentAttributes(META, "session-key-123")).toEqual({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.agent.id": "agent-1",
      "gen_ai.agent.name": "Test Agent",
      "gen_ai.conversation.id": "conv-1",
      "openclaw.session_key": "session-key-123",
    });
  });
});

describe("chatRequestAttributes", () => {
  it("emits the chat span name, request model, provider, and run id", () => {
    const attrs = chatRequestAttributes({
      agentName: "Test Agent",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      runId: "run-1",
    });
    expect(attrs["gen_ai.operation.name"]).toBe("chat");
    expect(attrs["gen_ai.agent.name"]).toBe("Test Agent");
    expect(attrs["gen_ai.provider.name"]).toBe("anthropic");
    expect(attrs["gen_ai.request.model"]).toBe("claude-sonnet-4-6");
    expect(attrs["openclaw.llm.run_id"]).toBe("run-1");
  });

  it("adds introspection.new_messages.* when input messages are present", () => {
    const attrs = chatRequestAttributes({
      agentName: "Test Agent",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      runId: "run-1",
      inputMessages: [
        { role: "user", parts: [{ type: "text", content: "hi" }] },
        { role: "user", parts: [{ type: "text", content: "again" }] },
      ],
    });
    expect(attrs["introspection.new_messages.start"]).toBe(1);
    expect(attrs["introspection.new_messages.end"]).toBe(2);
    expect(typeof attrs["gen_ai.input.messages"]).toBe("string");
  });

  it("falls back to a name-only tool definitions list when oversized", () => {
    const huge = "x".repeat(70_000);
    const attrs = chatRequestAttributes({
      agentName: "Test Agent",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      runId: "run-1",
      toolDefinitions: [
        { name: "lookup", description: huge, parameters: { huge } },
      ],
    });
    const tools = JSON.parse(attrs["gen_ai.tool.definitions"] as string);
    expect(tools).toEqual([{ name: "lookup" }]);
  });
});

describe("chatResponseAttributes", () => {
  it("emits semconv cache-token attribute names (with the dot)", () => {
    const attrs = chatResponseAttributes({
      responseModel: "claude-sonnet-4-6",
      usage: { input: 100, output: 50, cacheRead: 30, cacheWrite: 20 },
      finishReason: "end_turn",
      costUsd: 0.0042,
    });

    // Spec-correct names — the dotted form, not the underscore-only form
    // openclaw used to emit before this PR.
    expect(attrs["gen_ai.usage.cache_read.input_tokens"]).toBe(30);
    expect(attrs["gen_ai.usage.cache_creation.input_tokens"]).toBe(20);
    // Legacy openclaw.* keys are still emitted alongside for back-compat.
    expect(attrs["openclaw.usage.cache_read_tokens"]).toBe(30);
    expect(attrs["openclaw.usage.cache_write_tokens"]).toBe(20);

    expect(attrs["gen_ai.usage.input_tokens"]).toBe(100);
    expect(attrs["gen_ai.usage.output_tokens"]).toBe(50);
    expect(attrs["gen_ai.response.model"]).toBe("claude-sonnet-4-6");
    expect(attrs["gen_ai.response.finish_reasons"]).toEqual(["end_turn"]);
    expect(attrs["gen_ai.cost.usd"]).toBe(0.0042);
  });

  it("does not emit the deprecated `gen_ai.system` attribute", () => {
    const attrs = chatResponseAttributes({
      responseModel: "claude-sonnet-4-6",
      usage: { input: 10, output: 5 },
    });
    expect("gen_ai.system" in attrs).toBe(false);
    expect("gen_ai.provider.name" in attrs).toBe(false);
  });

  it("does not emit the legacy underscore-only cache attribute names", () => {
    const attrs = chatResponseAttributes({
      responseModel: "claude-sonnet-4-6",
      usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2 },
    });
    expect("gen_ai.usage.cache_read_input_tokens" in attrs).toBe(false);
    expect("gen_ai.usage.cache_creation_input_tokens" in attrs).toBe(false);
  });
});

describe("toolResponseChatAttributes", () => {
  it("includes the synthesised tool-result inputs and the new_messages range", () => {
    const attrs = toolResponseChatAttributes({
      agentName: "Test Agent",
      provider: "anthropic",
      requestModel: "claude-sonnet-4-6",
      responseModel: "claude-sonnet-4-6",
      inputMessages: [
        {
          role: "tool",
          name: "lookup",
          parts: [
            { type: "tool_call_response", id: "tool_1", response: "sunny" },
          ],
        },
      ],
      finishReason: "end_turn",
      outputMessages: [
        {
          role: "assistant",
          parts: [{ type: "text", content: "It's sunny." }],
        },
      ],
    });

    expect(attrs["introspection.new_messages.start"]).toBe(0);
    expect(attrs["introspection.new_messages.end"]).toBe(1);
    expect(typeof attrs["gen_ai.input.messages"]).toBe("string");
    expect(typeof attrs["gen_ai.output.messages"]).toBe("string");
    expect(attrs["gen_ai.response.finish_reasons"]).toEqual(["end_turn"]);
  });
});

describe("executeTool*", () => {
  it("emits semconv-correct argument and result attribute names", () => {
    const startAttrs = executeToolAttributes({
      toolName: "lookup",
      sequence: 1,
      params: { city: "Tokyo" },
      captureToolInput: true,
      maxCaptureLength: 2048,
    });

    // Spec-correct: tool input lives under gen_ai.tool.call.arguments
    // (was `gen_ai.tool.input` in the pre-migration plugin).
    expect(startAttrs["gen_ai.operation.name"]).toBe("execute_tool");
    expect(startAttrs["gen_ai.tool.name"]).toBe("lookup");
    expect(startAttrs["gen_ai.tool.type"]).toBe("function");
    expect(startAttrs["gen_ai.tool.call.arguments"]).toBe('{"city":"Tokyo"}');
    expect("gen_ai.tool.input" in startAttrs).toBe(false);
    expect(startAttrs["openclaw.tool.sequence"]).toBe(1);

    const endAttrs = executeToolResultAttributes({
      durationMs: 12,
      message: "Clear, 25°C",
      captureToolOutput: true,
      maxCaptureLength: 2048,
    });
    expect(endAttrs["gen_ai.tool.call.result"]).toBe("Clear, 25°C");
    expect("gen_ai.tool.output" in endAttrs).toBe(false);
    expect(endAttrs["openclaw.tool.duration_ms"]).toBe(12);
  });

  it("respects capture flags — omits content but still records sizes", () => {
    const startAttrs = executeToolAttributes({
      toolName: "lookup",
      sequence: 1,
      params: { city: "Tokyo" },
      captureToolInput: false,
      maxCaptureLength: 2048,
    });
    expect("gen_ai.tool.call.arguments" in startAttrs).toBe(false);
    expect(startAttrs["openclaw.tool.input_size"]).toBeGreaterThan(0);

    const endAttrs = executeToolResultAttributes({
      durationMs: 5,
      message: "x",
      captureToolOutput: false,
      maxCaptureLength: 2048,
    });
    expect("gen_ai.tool.call.result" in endAttrs).toBe(false);
    expect(endAttrs["openclaw.tool.output_size"]).toBe(1);
  });
});

describe("agentEndAttributes", () => {
  it("emits cumulative token counts and request stats", () => {
    const attrs = agentEndAttributes({
      durationMs: 1234,
      toolCount: 2,
      tokens: { input: 500, output: 200, cacheRead: 100, cacheWrite: 50 },
      model: "claude-sonnet-4-6",
      provider: "anthropic",
    });

    expect(attrs["openclaw.request.duration_ms"]).toBe(1234);
    expect(attrs["openclaw.request.tool_count"]).toBe(2);
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(500);
    expect(attrs["gen_ai.usage.output_tokens"]).toBe(200);
    expect(attrs["openclaw.usage.cache_read_tokens"]).toBe(100);
    expect(attrs["openclaw.usage.cache_write_tokens"]).toBe(50);
    expect(attrs["gen_ai.request.model"]).toBe("claude-sonnet-4-6");
    expect(attrs["gen_ai.response.model"]).toBe("claude-sonnet-4-6");
    expect(attrs["gen_ai.provider.name"]).toBe("anthropic");
  });

  it("omits per-call token attrs when no tokens were accumulated", () => {
    const attrs = agentEndAttributes({
      durationMs: 100,
      toolCount: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect("gen_ai.usage.input_tokens" in attrs).toBe(false);
    expect("openclaw.usage.cache_read_tokens" in attrs).toBe(false);
  });
});

describe("usageAttributes", () => {
  it("returns an empty record for undefined input", () => {
    expect(usageAttributes(undefined)).toEqual({});
  });
});
