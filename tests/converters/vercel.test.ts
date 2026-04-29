/**
 * Unit tests for Vercel AI SDK telemetry → GenAI converter.
 *
 * These tests verify tool schema extraction without making provider calls.
 */

import { describe, expect, it } from "vitest";

import { convertVercelAIToGenAI } from "../../packages/introspection-node/src/converters/vercel";

describe("convertVercelAIToGenAI", () => {
  it("emits tool parameters from ai.prompt.tools inputSchema", () => {
    const result = convertVercelAIToGenAI({
      "ai.operationId": "ai.generateText.doGenerate",
      "ai.prompt.tools": JSON.stringify([
        {
          type: "function",
          name: "get_weather",
          description: "Get weather for a city.",
          inputSchema: {
            type: "object",
            properties: {
              city: { type: "string", description: "City name" },
            },
            required: ["city"],
          },
        },
      ]),
    });

    expect(JSON.parse(result["gen_ai.tool.definitions"] as string)).toEqual([
      {
        type: "function",
        name: "get_weather",
        description: "Get weather for a city.",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string", description: "City name" },
          },
          required: ["city"],
        },
      },
    ]);
  });

  it("emits tool parameters from ai.prompt.tools parameters", () => {
    const result = convertVercelAIToGenAI({
      "ai.operationId": "ai.generateText.doGenerate",
      "ai.prompt.tools": JSON.stringify([
        JSON.stringify({
          name: "create_page",
          description: "Create a page.",
          parameters: {
            type: "object",
            properties: {
              title: { type: "string" },
            },
            required: ["title"],
          },
        }),
      ]),
    });

    expect(JSON.parse(result["gen_ai.tool.definitions"] as string)).toEqual([
      {
        type: "function",
        name: "create_page",
        description: "Create a page.",
        parameters: {
          type: "object",
          properties: {
            title: { type: "string" },
          },
          required: ["title"],
        },
      },
    ]);
  });
});
