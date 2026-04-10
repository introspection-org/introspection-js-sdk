/**
 * Integration test for Responses API encrypted reasoning.
 *
 * Records actual OpenAI API responses to validate that the tracing processor
 * correctly handles reasoning output items with encrypted content/signature.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Polly } from "@pollyjs/core";
import {
  Agent,
  run,
  addTraceProcessor,
  setTraceProcessors,
  setTracingDisabled,
} from "@openai/agents";

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

describe("Responses API - Encrypted Reasoning", () => {
  let capture: CaptureTracingProcessor | null = null;
  let polly: Polly | null = null;

  beforeEach(() => {
    polly = setupPolly({
      recordingName: "responses-api-reasoning",
      adapters: ["fetch"],
    });

    if (
      !ensureEnvVarsForReplay(["OPENAI_API_KEY"], "responses-api-reasoning")
    ) {
      console.log(
        "Skipping: Required env vars not set for record/passthrough mode",
      );
      polly.stop();
      polly = null;
      return;
    }

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

  it("should capture encrypted reasoning with signature and correct gen_ai attributes", async () => {
    if (!capture) return;

    const agent = new Agent({
      name: "Encrypted Reasoning Agent",
      model: "gpt-5.4",
      instructions: "Think carefully before answering.",
      modelSettings: {
        reasoning: { effort: "high", summary: "detailed" },
        providerData: { include: ["reasoning.encrypted_content"] },
      },
    });

    const result = await run(
      agent,
      "If a train travels at 120 km/h for 2.5 hours, then slows to 80 km/h for 1.75 hours, what is the total distance and average speed?",
    );
    expect(result.finalOutput).toBeDefined();

    await capture.processor.forceFlush();
    const spans = capture.exporter.getFinishedSpans();
    const sortedSpans = sortSpansBySpanId(spans);

    expect(sortedSpans.length).toBeGreaterThanOrEqual(2);

    const simplified = simplifySpansForSnapshot(sortedSpans, {
      normalize: true,
    });

    // Agent span — shows agent configuration
    const agentSpan = simplified.find(
      (s) => s.name === "Encrypted Reasoning Agent",
    );
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
          "gen_ai.agent.name": "Encrypted Reasoning Agent",
          "gen_ai.agent.output_type": "text",
          "gen_ai.conversation.id": "<conversation_id>",
          "gen_ai.system": "openai",
          "gen_ai.tool.definitions": "[]",
          "openai_agents.span_data": "<span_data>",
          "openinference.span.kind": "AGENT",
        },
        "name": "Encrypted Reasoning Agent",
        "span_id": Any<String>,
        "trace_id": Any<String>,
      }
    `,
    );

    // Response span — has gen_ai attributes with reasoning output
    const responseSpans = simplified.filter((s) => s.name === "response");
    expect(responseSpans.length).toBeGreaterThanOrEqual(1);
    expect(responseSpans[0]).toMatchInlineSnapshot(
      {
        trace_id: expect.any(String),
        span_id: expect.any(String),
      },
      `
      {
        "attributes": {
          "gen_ai.conversation.id": "<conversation_id>",
          "gen_ai.input.messages": "[{"role":"user","parts":[{"type":"text","content":"If a train travels at 120 km/h for 2.5 hours, then slows to 80 km/h for 1.75 hours, what is the total distance and average speed?"}]}]",
          "gen_ai.operation.name": "chat",
          "gen_ai.output.messages": "<output_messages>",
          "gen_ai.request.model": "gpt-5.4-2026-03-05",
          "gen_ai.response.id": "<response_id>",
          "gen_ai.system": "openai",
          "gen_ai.system_instructions": "[{"type":"text","content":"Think carefully before answering."}]",
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

    // Validate thinking parts with signature in raw (non-normalized) output
    const rawResponseSpans = sortedSpans.filter((s) => s.name === "response");
    expect(rawResponseSpans.length).toBeGreaterThanOrEqual(1);

    const outputMessages = parseJsonAttr(
      rawResponseSpans[0].attributes["gen_ai.output.messages"],
    ) as Array<{
      role: string;
      parts: Array<{ type: string; signature?: string; content?: string }>;
    }>;

    const allParts = outputMessages.flatMap((msg) => msg.parts || []);

    // Should have thinking parts (from reasoning output)
    const thinkingParts = allParts.filter((p) => p.type === "thinking");
    expect(thinkingParts.length).toBeGreaterThanOrEqual(1);

    // At least one thinking part should have a signature (encrypted content)
    const hasSignature = thinkingParts.some((p) => !!p.signature);
    expect(hasSignature).toBe(true);

    // Should also have text parts (the actual answer)
    const textParts = allParts.filter((p) => p.type === "text");
    expect(textParts.length).toBeGreaterThanOrEqual(1);
  });
});
