/**
 * Unit tests for AI SDK → GenAI converter.
 *
 * These tests verify tool schema extraction without making provider calls.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";

import { convertToolsToToolDefinitions } from "../../packages/introspection-node/src/converters/ai-sdk";

describe("convertToolsToToolDefinitions", () => {
  it("extracts AI SDK v6 inputSchema tools", () => {
    const result = convertToolsToToolDefinitions({
      notionCreatePage: {
        description: "Create a Notion page.",
        inputSchema: z.object({
          parent: z
            .union([
              z.object({ databaseId: z.string() }),
              z.object({ pageId: z.string() }),
            ])
            .describe("Parent database or page."),
          properties: z.record(z.string(), z.unknown()).optional(),
        }),
      },
    });

    expect(result).toHaveLength(1);
    expect(result?.[0]?.name).toBe("notionCreatePage");
    expect(result?.[0]?.description).toBe("Create a Notion page.");
    expect(result?.[0]?.parameters?.type).toBe("object");
    expect(result?.[0]?.parameters?.properties).toHaveProperty("parent");
  });

  it("still extracts legacy parameters tools", () => {
    const result = convertToolsToToolDefinitions({
      getWeather: {
        description: "Get weather.",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string" },
          },
          required: ["city"],
        },
      },
    });

    expect(result).toEqual([
      {
        name: "getWeather",
        description: "Get weather.",
        parameters: {
          type: "object",
          properties: {
            city: { type: "string" },
          },
          required: ["city"],
        },
      },
    ]);
  });
});
