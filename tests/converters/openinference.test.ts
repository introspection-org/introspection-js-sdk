/**
 * Unit tests for OpenInference → GenAI converter.
 *
 * These tests verify that OpenInference span attributes are correctly converted
 * to OTel Gen AI semantic convention attributes. No API keys required.
 */

import { describe, it, expect } from "vitest";
import type { Attributes } from "@opentelemetry/api";

// Import converters directly from source
import {
  isOpenInferenceSpan,
  convertOpenInferenceToGenAI,
  replaceOpenInferenceWithGenAI,
} from "../../packages/introspection-node/src/converters/openinference";

describe("isOpenInferenceSpan", () => {
  it("should return true for openinference scope names", () => {
    expect(isOpenInferenceSpan("openinference")).toBe(true);
    expect(isOpenInferenceSpan("openinference.instrumentation.openai")).toBe(
      true,
    );
    expect(
      isOpenInferenceSpan("@arizeai/openinference-instrumentation-openai"),
    ).toBe(true);
  });

  it("should return false for non-openinference scope names", () => {
    expect(isOpenInferenceSpan("opentelemetry")).toBe(false);
    expect(isOpenInferenceSpan("my-app")).toBe(false);
    expect(isOpenInferenceSpan(undefined)).toBe(false);
    expect(isOpenInferenceSpan("")).toBe(false);
  });
});

describe("convertOpenInferenceToGenAI", () => {
  it("should extract model name", () => {
    const attrs: Attributes = {
      "llm.model_name": "gpt-4o",
    };
    const result = convertOpenInferenceToGenAI(attrs);
    expect(result.requestModel).toBe("gpt-4o");
  });

  it("should extract system name", () => {
    const attrs: Attributes = {
      "llm.system": "openai",
    };
    const result = convertOpenInferenceToGenAI(attrs);
    expect(result.system).toBe("openai");
  });

  it("should extract token counts", () => {
    const attrs: Attributes = {
      "llm.token_count.prompt": 42,
      "llm.token_count.completion": 15,
    };
    const result = convertOpenInferenceToGenAI(attrs);
    expect(result.inputTokens).toBe(42);
    expect(result.outputTokens).toBe(15);
  });

  it("should extract input messages", () => {
    const attrs: Attributes = {
      "llm.input_messages.0.message.role": "user",
      "llm.input_messages.0.message.content":
        "What is the weather in San Francisco?",
    };
    const result = convertOpenInferenceToGenAI(attrs);
    expect(result.inputMessages).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", content: "What is the weather in San Francisco?" },
        ],
      },
    ]);
  });

  it("should extract multiple input messages in order", () => {
    const attrs: Attributes = {
      "llm.input_messages.0.message.role": "system",
      "llm.input_messages.0.message.content": "You are a helpful assistant.",
      "llm.input_messages.1.message.role": "user",
      "llm.input_messages.1.message.content": "Hello",
    };
    const result = convertOpenInferenceToGenAI(attrs);
    expect(result.inputMessages).toEqual([
      {
        role: "system",
        parts: [{ type: "text", content: "You are a helpful assistant." }],
      },
      {
        role: "user",
        parts: [{ type: "text", content: "Hello" }],
      },
    ]);
  });

  it("should extract output messages with text content", () => {
    const attrs: Attributes = {
      "llm.output_messages.0.message.role": "assistant",
      "llm.output_messages.0.message.content": "Hello! How can I help you?",
    };
    const result = convertOpenInferenceToGenAI(attrs);
    expect(result.outputMessages).toEqual([
      {
        role: "assistant",
        parts: [{ type: "text", content: "Hello! How can I help you?" }],
      },
    ]);
  });

  it("should extract output messages with tool calls", () => {
    const attrs: Attributes = {
      "llm.output_messages.0.message.role": "assistant",
      "llm.output_messages.0.message.tool_calls.0.tool_call.function.name":
        "get_weather",
      "llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments":
        '{"city":"Tokyo"}',
      "llm.output_messages.0.message.tool_calls.0.tool_call.id": "call_123",
    };
    const result = convertOpenInferenceToGenAI(attrs);
    expect(result.outputMessages).toEqual([
      {
        role: "assistant",
        parts: [
          {
            type: "tool_call",
            name: "get_weather",
            arguments: '{"city":"Tokyo"}',
            id: "call_123",
          },
        ],
      },
    ]);
  });

  it("should extract tool definitions from json_schema attributes", () => {
    const attrs: Attributes = {
      "llm.tools.0.tool.json_schema": JSON.stringify({
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather for a given city.",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      }),
    };
    const result = convertOpenInferenceToGenAI(attrs);
    expect(result.toolDefinitions).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "Get weather for a given city.",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ]);
  });

  it("should extract response ID from output.value", () => {
    const attrs: Attributes = {
      "output.value": JSON.stringify({ id: "chatcmpl-abc123" }),
    };
    const result = convertOpenInferenceToGenAI(attrs);
    expect(result.responseId).toBe("chatcmpl-abc123");
  });

  it("should prefer existing gen_ai.response.id over output.value", () => {
    const attrs: Attributes = {
      "gen_ai.response.id": "existing-id",
      "output.value": JSON.stringify({ id: "from-output" }),
    };
    const result = convertOpenInferenceToGenAI(attrs);
    expect(result.responseId).toBe("existing-id");
  });

  it("should extract LangChain response ID from nested structure", () => {
    const attrs: Attributes = {
      "output.value": JSON.stringify({
        generations: [
          [{ message: { kwargs: { id: "chatcmpl-langchain-123" } } }],
        ],
      }),
    };
    const result = convertOpenInferenceToGenAI(attrs);
    expect(result.responseId).toBe("chatcmpl-langchain-123");
  });

  it("should return empty object for undefined attrs", () => {
    const result = convertOpenInferenceToGenAI(undefined);
    expect(result).toEqual({});
  });

  it("should return empty object for attrs without OI keys", () => {
    const attrs: Attributes = {
      "custom.key": "value",
      "another.key": 42,
    };
    const result = convertOpenInferenceToGenAI(attrs);
    expect(result).toEqual({});
  });
});

describe("replaceOpenInferenceWithGenAI", () => {
  it("should replace OI attributes with gen_ai attributes", () => {
    const attrs: Attributes = {
      "llm.model_name": "gpt-4o",
      "llm.system": "openai",
      "llm.token_count.prompt": 10,
      "llm.token_count.completion": 20,
      "llm.input_messages.0.message.role": "user",
      "llm.input_messages.0.message.content": "Hello",
      "input.mime_type": "application/json",
      "openinference.span.kind": "LLM",
    };

    const result = replaceOpenInferenceWithGenAI(attrs);

    // gen_ai attributes should be present
    expect(result["gen_ai.request.model"]).toBe("gpt-4o");
    expect(result["gen_ai.system"]).toBe("openai");
    expect(result["gen_ai.usage.input_tokens"]).toBe(10);
    expect(result["gen_ai.usage.output_tokens"]).toBe(20);
    expect(result["gen_ai.input.messages"]).toBe(
      JSON.stringify([
        { role: "user", parts: [{ type: "text", content: "Hello" }] },
      ]),
    );

    // Non-OI attributes should be preserved
    expect(result["input.mime_type"]).toBe("application/json");
    expect(result["openinference.span.kind"]).toBe("LLM");

    // OI attributes should be removed
    expect(result["llm.model_name"]).toBeUndefined();
    expect(result["llm.system"]).toBeUndefined();
    expect(result["llm.token_count.prompt"]).toBeUndefined();
    expect(result["llm.input_messages.0.message.role"]).toBeUndefined();
  });

  it("should handle empty attributes", () => {
    const result = replaceOpenInferenceWithGenAI({});
    expect(result).toEqual({});
  });

  it("should handle undefined attributes", () => {
    const result = replaceOpenInferenceWithGenAI(undefined);
    expect(result).toEqual({});
  });

  it("should preserve non-OI attributes while converting OI attributes", () => {
    const attrs: Attributes = {
      "custom.attribute": "preserved",
      "llm.model_name": "gpt-4o",
    };
    const result = replaceOpenInferenceWithGenAI(attrs);
    expect(result["custom.attribute"]).toBe("preserved");
    expect(result["gen_ai.request.model"]).toBe("gpt-4o");
    expect(result["llm.model_name"]).toBeUndefined();
  });
});
