/**
 * Unit tests for Gemini → GenAI converter.
 *
 * Validates that per-part `thoughtSignature` payloads from the @google/genai
 * SDK are correctly translated into `thinking` gen_ai parts (with content
 * `"[redacted]"` for signed-but-non-thought parts and the visible thought text
 * for parts where `thought: true`). No API keys required.
 */

import { describe, it, expect } from "vitest";
import {
  convertGeminiContentsToInputMessages,
  convertGeminiCandidatesToOutputMessages,
  convertGeminiSystemInstructionToSemconv,
  convertGeminiToolsToToolDefinitions,
} from "../../packages/introspection-node/src/converters/gemini";

describe("convertGeminiCandidatesToOutputMessages", () => {
  it("emits a redacted thinking part for a function call that carries a thought signature", () => {
    const candidates = [
      {
        content: {
          role: "model",
          parts: [
            {
              functionCall: {
                name: "get_current_temperature",
                args: { city: "Paris" },
              },
              thoughtSignature: "Signature_A",
            },
            {
              functionCall: {
                name: "get_current_temperature",
                args: { city: "London" },
              },
            },
          ],
        },
        finishReason: "STOP",
      },
    ];

    const result = convertGeminiCandidatesToOutputMessages(candidates);

    expect(JSON.stringify(result)).toBe(
      JSON.stringify([
        {
          role: "assistant",
          parts: [
            {
              type: "thinking",
              content: "[redacted]",
              signature: "Signature_A",
              provider_name: "gemini",
            },
            {
              type: "tool_call",
              name: "get_current_temperature",
              arguments: { city: "Paris" },
            },
            {
              type: "tool_call",
              name: "get_current_temperature",
              arguments: { city: "London" },
            },
          ],
          finish_reason: "STOP",
        },
      ]),
    );
  });

  it("uses the visible thought text when a part is marked thought: true", () => {
    const candidates = [
      {
        content: {
          role: "model",
          parts: [
            {
              thought: true,
              text: "Let me work through this step by step...",
              thoughtSignature: "Signature_T",
            },
            { text: "The answer is 42." },
          ],
        },
        finishReason: "STOP",
      },
    ];

    const result = convertGeminiCandidatesToOutputMessages(candidates);

    expect(JSON.stringify(result)).toBe(
      JSON.stringify([
        {
          role: "assistant",
          parts: [
            {
              type: "thinking",
              content: "Let me work through this step by step...",
              signature: "Signature_T",
              provider_name: "gemini",
            },
            { type: "text", content: "The answer is 42." },
          ],
          finish_reason: "STOP",
        },
      ]),
    );
  });

  it("emits a redacted thinking part alongside a plain text part when signed", () => {
    const candidates = [
      {
        content: {
          role: "model",
          parts: [{ text: "Hello world", thoughtSignature: "sig_text" }],
        },
        finishReason: "STOP",
      },
    ];

    const result = convertGeminiCandidatesToOutputMessages(candidates);

    expect(result).toEqual([
      {
        role: "assistant",
        parts: [
          {
            type: "thinking",
            content: "[redacted]",
            signature: "sig_text",
            provider_name: "gemini",
          },
          { type: "text", content: "Hello world" },
        ],
        finish_reason: "STOP",
      },
    ]);
  });

  it("returns no thinking part when a part has no thought signature", () => {
    const candidates = [
      {
        content: {
          role: "model",
          parts: [{ text: "Just text." }],
        },
        finishReason: "STOP",
      },
    ];

    const result = convertGeminiCandidatesToOutputMessages(candidates);

    expect(result).toEqual([
      {
        role: "assistant",
        parts: [{ type: "text", content: "Just text." }],
        finish_reason: "STOP",
      },
    ]);
  });
});

describe("convertGeminiContentsToInputMessages", () => {
  it("accepts a plain string prompt", () => {
    const result = convertGeminiContentsToInputMessages("Hello, Gemini!");

    expect(result).toEqual([
      { role: "user", parts: [{ type: "text", content: "Hello, Gemini!" }] },
    ]);
  });

  it("normalizes the `model` role to `assistant` and preserves thought signatures", () => {
    const contents = [
      { role: "user", parts: [{ text: "What's the weather in Paris?" }] },
      {
        role: "model",
        parts: [
          {
            functionCall: {
              name: "get_current_temperature",
              args: { city: "Paris" },
            },
            thoughtSignature: "Signature_A",
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "get_current_temperature",
              response: { temperature: 18 },
            },
          },
        ],
      },
    ];

    const result = convertGeminiContentsToInputMessages(contents);

    expect(result).toEqual([
      {
        role: "user",
        parts: [{ type: "text", content: "What's the weather in Paris?" }],
      },
      {
        role: "assistant",
        parts: [
          {
            type: "thinking",
            content: "[redacted]",
            signature: "Signature_A",
            provider_name: "gemini",
          },
          {
            type: "tool_call",
            name: "get_current_temperature",
            arguments: { city: "Paris" },
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            type: "tool_call_response",
            name: "get_current_temperature",
            response: { temperature: 18 },
          },
        ],
      },
    ]);
  });
});

describe("convertGeminiSystemInstructionToSemconv", () => {
  it("accepts a plain string", () => {
    expect(convertGeminiSystemInstructionToSemconv("You are helpful.")).toEqual(
      [{ type: "text", content: "You are helpful." }],
    );
  });

  it("extracts text parts from a Content envelope", () => {
    const result = convertGeminiSystemInstructionToSemconv({
      role: "system",
      parts: [{ text: "First." }, { text: "Second." }],
    });
    expect(result).toEqual([
      { type: "text", content: "First." },
      { type: "text", content: "Second." },
    ]);
  });

  it("returns undefined when no instruction is provided", () => {
    expect(convertGeminiSystemInstructionToSemconv(undefined)).toBeUndefined();
  });
});

describe("convertGeminiToolsToToolDefinitions", () => {
  it("flattens functionDeclarations across tools", () => {
    const result = convertGeminiToolsToToolDefinitions([
      {
        functionDeclarations: [
          {
            name: "get_current_temperature",
            description: "Get the temperature for a city.",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        ],
      },
      {
        functionDeclarations: [{ name: "send_email" }],
      },
    ]);

    expect(result).toEqual([
      {
        name: "get_current_temperature",
        description: "Get the temperature for a city.",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
      { name: "send_email" },
    ]);
  });

  it("prefers parametersJsonSchema over parameters when both are present", () => {
    const result = convertGeminiToolsToToolDefinitions([
      {
        functionDeclarations: [
          {
            name: "foo",
            parameters: { type: "object", properties: {} },
            parametersJsonSchema: {
              type: "object",
              properties: { x: { type: "number" } },
            },
          },
        ],
      },
    ]);

    expect(result?.[0].parameters).toEqual({
      type: "object",
      properties: { x: { type: "number" } },
    });
  });
});
