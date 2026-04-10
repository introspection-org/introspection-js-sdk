/**
 * Unit tests for OpenAI → GenAI converter.
 *
 * Tests that OpenAI Responses API inputs/outputs are correctly converted
 * to OTel Gen AI semantic convention format. No API keys required.
 */

import { describe, it, expect } from "vitest";
import {
  convertResponsesInputsToSemconv,
  convertResponsesOutputsToSemconv,
} from "../../packages/introspection-node/src/converters/openai";

describe("convertResponsesInputsToSemconv", () => {
  it("should convert simple user message", () => {
    const inputs = [{ role: "user", content: "Hello" }];
    const [inputMessages, systemInstructions] = convertResponsesInputsToSemconv(
      inputs,
      undefined,
    );

    expect(JSON.stringify(inputMessages)).toBe(
      JSON.stringify([
        { role: "user", parts: [{ type: "text", content: "Hello" }] },
      ]),
    );
    expect(systemInstructions).toEqual([]);
  });

  it("should include system instructions", () => {
    const [inputMessages, systemInstructions] = convertResponsesInputsToSemconv(
      [],
      "You are a helpful assistant.",
    );

    expect(inputMessages).toEqual([]);
    expect(JSON.stringify(systemInstructions)).toBe(
      JSON.stringify([
        {
          role: "system",
          parts: [{ type: "text", content: "You are a helpful assistant." }],
        },
      ]),
    );
  });

  it("should convert message with type field", () => {
    const inputs = [{ type: "message", role: "user", content: "Hello" }];
    const [inputMessages] = convertResponsesInputsToSemconv(inputs, undefined);

    expect(JSON.stringify(inputMessages)).toBe(
      JSON.stringify([
        { role: "user", parts: [{ type: "text", content: "Hello" }] },
      ]),
    );
  });

  it("should convert function_call input", () => {
    const inputs = [
      {
        type: "function_call",
        name: "get_weather",
        call_id: "call_123",
        arguments: '{"city":"Tokyo"}',
      },
    ];
    const [inputMessages] = convertResponsesInputsToSemconv(inputs, undefined);

    expect(JSON.stringify(inputMessages)).toBe(
      JSON.stringify([
        {
          role: "assistant",
          parts: [
            {
              type: "tool_call",
              id: "call_123",
              name: "get_weather",
              arguments: '{"city":"Tokyo"}',
            },
          ],
        },
      ]),
    );
  });

  it("should convert function_call_output input", () => {
    const inputs = [
      {
        type: "function_call_output",
        call_id: "call_123",
        name: "get_weather",
        output: "Sunny, 72F",
      },
    ];
    const [inputMessages] = convertResponsesInputsToSemconv(inputs, undefined);

    expect(JSON.stringify(inputMessages)).toBe(
      JSON.stringify([
        {
          role: "tool",
          parts: [
            {
              type: "tool_call_response",
              id: "call_123",
              response: "Sunny, 72F",
            },
          ],
          name: "get_weather",
        },
      ]),
    );
  });

  it("should convert array content with output_text items", () => {
    const inputs = [
      {
        role: "assistant",
        content: [{ type: "output_text", text: "The weather is sunny." }],
      },
    ];
    const [inputMessages] = convertResponsesInputsToSemconv(inputs, undefined);

    expect(JSON.stringify(inputMessages)).toBe(
      JSON.stringify([
        {
          role: "assistant",
          parts: [{ type: "text", content: "The weather is sunny." }],
        },
      ]),
    );
  });

  it("should handle empty inputs", () => {
    const [inputMessages, systemInstructions] = convertResponsesInputsToSemconv(
      undefined,
      undefined,
    );
    expect(inputMessages).toEqual([]);
    expect(systemInstructions).toEqual([]);
  });

  it("should handle both system instructions and user messages", () => {
    const inputs = [{ role: "user", content: "What's the weather?" }];
    const [inputMessages, systemInstructions] = convertResponsesInputsToSemconv(
      inputs,
      "Be helpful.",
    );

    expect(JSON.stringify(systemInstructions)).toBe(
      JSON.stringify([
        {
          role: "system",
          parts: [{ type: "text", content: "Be helpful." }],
        },
      ]),
    );
    expect(JSON.stringify(inputMessages)).toBe(
      JSON.stringify([
        {
          role: "user",
          parts: [{ type: "text", content: "What's the weather?" }],
        },
      ]),
    );
  });
});

describe("convertResponsesOutputsToSemconv", () => {
  it("should convert simple text output", () => {
    const outputs = [
      {
        type: "message",
        content: [{ type: "output_text", text: "Hello! How can I help?" }],
      },
    ];
    const result = convertResponsesOutputsToSemconv(outputs);

    expect(JSON.stringify(result)).toBe(
      JSON.stringify([
        {
          role: "assistant",
          parts: [{ type: "text", content: "Hello! How can I help?" }],
        },
      ]),
    );
  });

  it("should convert string content output", () => {
    const outputs = [{ content: "Hello world" }];
    const result = convertResponsesOutputsToSemconv(outputs);

    expect(JSON.stringify(result)).toBe(
      JSON.stringify([
        {
          role: "assistant",
          parts: [{ type: "text", content: "Hello world" }],
        },
      ]),
    );
  });

  it("should convert function_call output", () => {
    const outputs = [
      {
        type: "function_call",
        name: "get_weather",
        call_id: "call_456",
        arguments: '{"city":"Paris"}',
      },
    ];
    const result = convertResponsesOutputsToSemconv(outputs);

    expect(JSON.stringify(result)).toBe(
      JSON.stringify([
        {
          role: "assistant",
          finish_reason: "tool-calls",
          parts: [
            {
              type: "tool_call",
              id: "call_456",
              name: "get_weather",
              arguments: '{"city":"Paris"}',
            },
          ],
        },
      ]),
    );
  });

  it("should handle empty outputs", () => {
    const result = convertResponsesOutputsToSemconv([]);
    expect(result).toEqual([]);
  });

  it("should convert reasoning with summary merged into next message", () => {
    const outputs = [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [
          { text: "Thinking about the problem...", type: "summary_text" },
          { text: "Breaking it down step by step.", type: "summary_text" },
        ],
      },
      {
        type: "message",
        status: "completed",
        content: [{ type: "output_text", text: "The answer is 42." }],
      },
    ];
    const result = convertResponsesOutputsToSemconv(outputs);

    expect(JSON.stringify(result)).toBe(
      JSON.stringify([
        {
          role: "assistant",
          parts: [
            {
              type: "thinking",
              content:
                "Thinking about the problem...\nBreaking it down step by step.",
              provider_name: "openai",
            },
            { type: "text", content: "The answer is 42." },
          ],
          finish_reason: "stop",
        },
      ]),
    );
  });

  it("should convert encrypted reasoning with signature merged into next message", () => {
    const outputs = [
      {
        type: "reasoning",
        id: "rs_1",
        summary: [],
        encrypted_content: "opaque-blob",
      },
      {
        type: "message",
        status: "completed",
        content: [{ type: "output_text", text: "The answer is 42." }],
      },
    ];
    const result = convertResponsesOutputsToSemconv(outputs);

    expect(JSON.stringify(result)).toBe(
      JSON.stringify([
        {
          role: "assistant",
          parts: [
            {
              type: "thinking",
              signature: "opaque-blob",
              provider_name: "openai",
            },
            { type: "text", content: "The answer is 42." },
          ],
          finish_reason: "stop",
        },
      ]),
    );
  });

  it("should include finish_reason on function_call and message outputs", () => {
    const outputs = [
      {
        type: "function_call",
        name: "search",
        call_id: "call_1",
        arguments: '{"q":"test"}',
      },
    ];
    const result = convertResponsesOutputsToSemconv(outputs);

    expect(JSON.stringify(result)).toBe(
      JSON.stringify([
        {
          role: "assistant",
          finish_reason: "tool-calls",
          parts: [
            {
              type: "tool_call",
              id: "call_1",
              name: "search",
              arguments: '{"q":"test"}',
            },
          ],
        },
      ]),
    );
  });

  it("should handle multiple outputs", () => {
    const outputs = [
      {
        type: "function_call",
        name: "get_weather",
        call_id: "call_1",
        arguments: '{"city":"Tokyo"}',
      },
      {
        type: "function_call",
        name: "get_time",
        call_id: "call_2",
        arguments: '{"timezone":"JST"}',
      },
    ];
    const result = convertResponsesOutputsToSemconv(outputs);

    expect(JSON.stringify(result)).toBe(
      JSON.stringify([
        {
          role: "assistant",
          finish_reason: "tool-calls",
          parts: [
            {
              type: "tool_call",
              id: "call_1",
              name: "get_weather",
              arguments: '{"city":"Tokyo"}',
            },
          ],
        },
        {
          role: "assistant",
          finish_reason: "tool-calls",
          parts: [
            {
              type: "tool_call",
              id: "call_2",
              name: "get_time",
              arguments: '{"timezone":"JST"}',
            },
          ],
        },
      ]),
    );
  });
});
