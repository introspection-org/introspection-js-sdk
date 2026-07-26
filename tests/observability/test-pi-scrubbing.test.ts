/**
 * Tests for gen_ai content scrubbing — the attribute-predicate exporter
 * wrapper for hosts exporting one span stream to two data-policy planes.
 */

import { describe, expect, it } from "vitest";
import {
  GenAiContentScrubbingExporter,
  isGenAiContentAttribute,
  scrubGenAiContent,
  type ScrubbableSpan,
} from "../../packages/introspection-pi/src";

describe("isGenAiContentAttribute", () => {
  it("flags content attributes and keeps structural ones", () => {
    for (const key of [
      "gen_ai.input.messages",
      "gen_ai.output.messages",
      "gen_ai.system_instructions",
      "gen_ai.tool.definitions",
      "gen_ai.tool.call.arguments",
      "gen_ai.tool.call.result",
      "gen_ai_encrypted.input.messages",
    ]) {
      expect(isGenAiContentAttribute(key), key).toBe(true);
    }
    for (const key of [
      "gen_ai.operation.name",
      "gen_ai.provider.name",
      "gen_ai.request.model",
      "gen_ai.response.finish_reasons",
      "gen_ai.usage.input_tokens",
      "gen_ai.conversation.id",
      "gen_ai.tool.name",
      "gen_ai.tool.type",
      "http.request.method",
    ]) {
      expect(isGenAiContentAttribute(key), key).toBe(false);
    }
  });
});

describe("scrubGenAiContent", () => {
  it("strips content, keeps structure, never mutates the original", () => {
    const span = {
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.input.messages": "[secret]",
        "gen_ai.usage.output_tokens": 20,
        "gen_ai_encrypted.output.messages": "cipher",
      },
    };
    const scrubbed = scrubGenAiContent(span);
    expect(scrubbed.attributes).toEqual({
      "gen_ai.operation.name": "chat",
      "gen_ai.usage.output_tokens": 20,
    });
    // The original span still carries everything (a second exporter on the
    // same span stream must see it whole).
    expect(span.attributes["gen_ai.input.messages"]).toBe("[secret]");
  });

  it("passes spans without content attributes through as the same object", () => {
    const span = { attributes: { "http.request.method": "GET" } };
    expect(scrubGenAiContent(span)).toBe(span);
  });
});

describe("GenAiContentScrubbingExporter", () => {
  it("delegates scrubbed spans and forwards lifecycle calls", async () => {
    const seen: ScrubbableSpan[][] = [];
    let shutdowns = 0;
    let flushes = 0;
    const delegate = {
      export(
        spans: ScrubbableSpan[],
        cb: (result: { code: number; error?: Error }) => void,
      ) {
        seen.push(spans);
        cb({ code: 0 });
      },
      shutdown: async () => {
        shutdowns += 1;
      },
      forceFlush: async () => {
        flushes += 1;
      },
    };
    const exporter = new GenAiContentScrubbingExporter(delegate);

    const genai = {
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.output.messages": "[secret]",
      },
    };
    const plain = { attributes: { "http.request.method": "GET" } };
    await new Promise<void>((resolve) =>
      exporter.export([genai, plain], () => resolve()),
    );

    expect(seen[0]?.[0]?.attributes).toEqual({
      "gen_ai.operation.name": "chat",
    });
    expect(seen[0]?.[1]).toBe(plain);

    await exporter.forceFlush();
    await exporter.shutdown();
    expect(flushes).toBe(1);
    expect(shutdowns).toBe(1);
  });
});
