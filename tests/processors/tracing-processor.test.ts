/**
 * Integration tests for IntrospectionTracingProcessor.
 *
 * Tests that the tracing processor correctly captures OpenAI Agents SDK traces
 * and extracts gen_ai.* semantic convention attributes.
 *
 * Uses:
 * - InMemorySpanExporter to capture spans
 * - Inline snapshots with simplifySpansForSnapshot for normalized comparison
 *
 * Note: These tests make real API calls to OpenAI. Set OPENAI_API_KEY env var.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Polly } from "@pollyjs/core";
import {
  Agent,
  run,
  addTraceProcessor,
  setTraceProcessors,
  setTracingDisabled,
  tool,
} from "@openai/agents";
import { z } from "zod";

import {
  createCaptureTracingProcessor,
  type CaptureTracingProcessor,
} from "../fixtures";
import {
  simplifySpansForSnapshot,
  sortSpansBySpanId,
  parseJsonAttr,
} from "../testing";
import { setupPolly, ensureEnvVarsForReplay } from "../polly-setup";

describe("IntrospectionTracingProcessor", () => {
  let capture: CaptureTracingProcessor | null = null;
  let polly: Polly | null = null;

  beforeEach(() => {
    polly = setupPolly({
      recordingName: "tracing-processor",
      adapters: ["fetch"],
    });

    if (!ensureEnvVarsForReplay(["OPENAI_API_KEY"], "tracing-processor")) {
      console.log(
        "Skipping: Required env vars not set for record/passthrough mode",
      );
      polly.stop();
      polly = null;
      return;
    }

    // Enable tracing (OpenAI Agents SDK disables it when NODE_ENV=test)
    setTracingDisabled(false);

    capture = createCaptureTracingProcessor();
    addTraceProcessor(capture.processor);
  });

  afterEach(async () => {
    if (capture) {
      setTraceProcessors([]);
      await capture.processor.shutdown();
      capture = null;
    }
    if (polly) {
      await polly.stop();
      polly = null;
    }
  });

  it("should capture weather agent spans with correct gen_ai attributes", async () => {
    if (!capture) {
      return;
    }

    const getWeather = tool({
      name: "get_weather",
      description: "Get the current weather for a city",
      parameters: z.object({
        city: z.string().describe("The city to get weather for"),
      }),
      execute: async ({ city }) => ({
        city,
        temperature_range: "14-20C",
        conditions: "Sunny with light wind",
      }),
    });

    const agent = new Agent({
      name: "Weather Assistant",
      instructions:
        "You are a helpful weather assistant. When asked about weather, use the get_weather tool.",
      tools: [getWeather],
      model: "gpt-5-nano-2025-08-07",
    });

    const result = await run(agent, "What's the weather in Tokyo?");
    expect(result.finalOutput).toBeDefined();

    await capture.processor.forceFlush();
    const spans = capture.exporter.getFinishedSpans();
    const sortedSpans = sortSpansBySpanId(spans);

    expect(sortedSpans.length).toBeGreaterThanOrEqual(5);

    const simplified = simplifySpansForSnapshot(sortedSpans, {
      normalize: true,
    });

    // Agent span — shows agent configuration
    const agentSpan = simplified.find((s) => s.name === "Weather Assistant");
    expect(agentSpan).toBeDefined();
    expect(agentSpan).toMatchInlineSnapshot(
      {
        trace_id: expect.any(String),
        span_id: expect.any(String),
      },
      `
      {
        "attributes": {
          "gen_ai.agent.handoffs": "[]",
          "gen_ai.agent.name": "Weather Assistant",
          "gen_ai.agent.output_type": "text",
          "gen_ai.conversation.id": "<conversation_id>",
          "gen_ai.system": "openai",
          "gen_ai.tool.definitions": "[{"name":"get_weather"}]",
          "openai_agents.span_data": "<span_data>",
          "openinference.span.kind": "AGENT",
        },
        "name": "Weather Assistant",
        "span_id": Any<String>,
        "trace_id": Any<String>,
      }
    `,
    );

    // First response span — initial user message with gen_ai attributes
    const responseSpans = simplified.filter((s) => s.name === "response");
    expect(responseSpans.length).toBeGreaterThan(0);
    expect(responseSpans[0]).toMatchInlineSnapshot(
      {
        trace_id: expect.any(String),
        span_id: expect.any(String),
      },
      `
      {
        "attributes": {
          "gen_ai.conversation.id": "<conversation_id>",
          "gen_ai.input.messages": "[{"role":"user","parts":[{"type":"text","content":"What's the weather in Tokyo?"}]}]",
          "gen_ai.operation.name": "chat",
          "gen_ai.output.messages": "<output_messages>",
          "gen_ai.request.model": "gpt-5-nano-2025-08-07",
          "gen_ai.response.id": "<response_id>",
          "gen_ai.system": "openai",
          "gen_ai.system_instructions": "[{"type":"text","content":"You are a helpful weather assistant. When asked about weather, use the get_weather tool."}]",
          "gen_ai.tool.definitions": "[{"name":"get_weather","description":"Get the current weather for a city","parameters":{"type":"object","properties":{"city":{"type":"string","description":"The city to get weather for"}},"required":["city"],"additionalProperties":false}}]",
          "gen_ai.usage.input_tokens": "<input_tokens>",
          "gen_ai.usage.output_tokens": "<output_tokens>",
          "openai_agents.span_data": "<span_data>",
          "openinference.span.kind": "LLM",
        },
        "name": "response",
        "span_id": Any<String>,
        "trace_id": Any<String>,
      }
    `,
    );

    // Function/tool span — tool execution
    const functionSpan = simplified.find((s) => s.name === "get_weather");
    expect(functionSpan).toBeDefined();
    expect(functionSpan).toMatchInlineSnapshot(
      {
        trace_id: expect.any(String),
        span_id: expect.any(String),
      },
      `
      {
        "attributes": {
          "gen_ai.conversation.id": "<conversation_id>",
          "gen_ai.tool.input": "{"city":"Tokyo"}",
          "gen_ai.tool.name": "get_weather",
          "gen_ai.tool.output": "{"city":"Tokyo","temperature_range":"14-20C","conditions":"Sunny with light wind"}",
          "openai_agents.span_data": "<span_data>",
          "openinference.span.kind": "TOOL",
        },
        "name": "get_weather",
        "span_id": Any<String>,
        "trace_id": Any<String>,
      }
    `,
    );

    // Validate dynamic values on original (non-normalized) response spans
    const rawResponseSpans = sortedSpans.filter((s) => s.name === "response");
    for (const responseSpan of rawResponseSpans) {
      expect(responseSpan.attributes["gen_ai.request.model"]).toMatch(/^gpt-5/);

      // output messages are dynamic — validate it's valid JSON
      const outputMessages = parseJsonAttr(
        responseSpan.attributes["gen_ai.output.messages"],
      );
      expect(outputMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: expect.any(String) }),
        ]),
      );
    }

    // Second response span should include tool call in input messages
    if (rawResponseSpans.length >= 2) {
      const secondResponse = rawResponseSpans[1];
      const inputMessages = parseJsonAttr(
        secondResponse.attributes["gen_ai.input.messages"],
      ) as Array<{ role: string; parts: Array<{ type: string }> }>;
      expect(inputMessages.length).toBeGreaterThanOrEqual(2);
      const hasToolCall = inputMessages.some((m) =>
        m.parts.some((p) => p.type === "tool_call"),
      );
      expect(hasToolCall).toBe(true);
    }
  });
});
