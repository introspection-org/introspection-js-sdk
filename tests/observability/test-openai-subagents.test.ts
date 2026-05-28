/**
 * Tests for the OpenAI Agents SDK multi-agent subagent pattern.
 *
 * Covers the `withTrace(groupId)` → `gen_ai.conversation.id` linking
 * introduced in IntrospectionTracingProcessor, and verifies that
 * OpenAIChatCompletionsModel spans carry the ChatCompletion-extracted
 * attributes from the updated _processGenerationSpan code path.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Polly } from "@pollyjs/core";
import {
  Agent,
  run,
  addTraceProcessor,
  setTraceProcessors,
  setTracingDisabled,
  withTrace,
  OpenAIChatCompletionsModel,
} from "@openai/agents";
import OpenAI from "openai";
import {
  createCaptureTracingProcessor,
  type CaptureTracingProcessor,
} from "../fixtures";
import { simplifySpansForSnapshot, sortSpansBySpanId } from "../testing";
import { setupPolly, ensureEnvVarsForReplay } from "../polly-setup";

describe("OpenAI Subagents — groupId conversation linking", () => {
  let capture: CaptureTracingProcessor | null = null;
  let polly: Polly | null = null;

  beforeEach(() => {
    polly = setupPolly({
      recordingName: "openai-subagents",
      adapters: ["fetch"],
    });

    if (!ensureEnvVarsForReplay(["OPENAI_API_KEY"], "openai-subagents")) {
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

  it("assigns distinct conversation IDs for different withTrace groupIds", async () => {
    if (!capture) return;

    const openai = new OpenAI();
    const agent = new Agent({
      name: "mini-agent",
      model: new OpenAIChatCompletionsModel(openai, "gpt-4o-mini"),
      instructions: "Reply in exactly one word.",
    });

    const ORCHESTRATOR_ID = "orch-conv-subagent-test";
    const RESEARCHER_ID = "researcher-conv-subagent-test";

    await withTrace(
      "orchestrator-turn",
      async () => {
        await run(agent, "Say hello.");
      },
      { groupId: ORCHESTRATOR_ID },
    );

    await withTrace(
      "researcher-turn",
      async () => {
        await run(agent, "Say hello.");
      },
      { groupId: RESEARCHER_ID },
    );

    await capture.processor.forceFlush();
    const spans = capture.exporter.getFinishedSpans();
    const simplified = simplifySpansForSnapshot(spans);

    // groupId becomes gen_ai.conversation.id directly
    const orchestratorSpans = simplified.filter(
      (s) => s.attributes["gen_ai.conversation.id"] === ORCHESTRATOR_ID,
    );
    const researcherSpans = simplified.filter(
      (s) => s.attributes["gen_ai.conversation.id"] === RESEARCHER_ID,
    );

    expect(orchestratorSpans.length).toBeGreaterThan(0);
    expect(researcherSpans.length).toBeGreaterThan(0);

    // No spans should have an unexpected conversation ID
    const unexpectedConvIds = simplified.filter(
      (s) =>
        s.attributes["gen_ai.conversation.id"] !== undefined &&
        s.attributes["gen_ai.conversation.id"] !== ORCHESTRATOR_ID &&
        s.attributes["gen_ai.conversation.id"] !== RESEARCHER_ID,
    );
    expect(unexpectedConvIds).toHaveLength(0);
  });

  it("reuses the same conversation ID when groupId is shared across multiple withTrace calls", async () => {
    if (!capture) return;

    const openai = new OpenAI();
    const agent = new Agent({
      name: "mini-agent",
      model: new OpenAIChatCompletionsModel(openai, "gpt-4o-mini"),
      instructions: "Reply in exactly one word.",
    });

    const SHARED_ID = "shared-multi-turn-subagent-test";

    // Two separate withTrace calls with the same groupId simulate a
    // multi-turn orchestrator conversation (phase 1 and phase 3 in the example).
    await withTrace(
      "turn-1",
      async () => {
        await run(agent, "Say hello.");
      },
      { groupId: SHARED_ID },
    );

    await withTrace(
      "turn-2",
      async () => {
        await run(agent, "Say hello.");
      },
      { groupId: SHARED_ID },
    );

    await capture.processor.forceFlush();
    const spans = capture.exporter.getFinishedSpans();
    const simplified = simplifySpansForSnapshot(spans);

    const convIds = new Set(
      simplified
        .map((s) => s.attributes["gen_ai.conversation.id"])
        .filter(Boolean),
    );
    expect(convIds.size).toBe(1);
    expect(convIds.has(SHARED_ID)).toBe(true);
  });

  it("extracts ChatCompletion response attributes via updated _processGenerationSpan", async () => {
    if (!capture) return;

    const openai = new OpenAI();
    const agent = new Agent({
      name: "mini-agent",
      model: new OpenAIChatCompletionsModel(openai, "gpt-4o-mini"),
      instructions: "Reply in exactly one word.",
    });

    await withTrace(
      "single-turn",
      async () => {
        await run(agent, "Say hello.");
      },
      { groupId: "chat-completion-attrs-subagent-test" },
    );

    await capture.processor.forceFlush();
    const spans = capture.exporter.getFinishedSpans();
    const sorted = sortSpansBySpanId(spans);
    const simplified = simplifySpansForSnapshot(sorted);

    // OpenAIChatCompletionsModel stores the raw response in spanData.output[0];
    // _processGenerationSpan extracts the following from it.
    const genSpan = simplified.find(
      (s) =>
        typeof s.attributes["gen_ai.usage.input_tokens"] === "number" &&
        (s.attributes["gen_ai.usage.input_tokens"] as number) > 0,
    );
    expect(genSpan).toBeDefined();
    expect(genSpan?.attributes["gen_ai.response.id"]).toBeDefined();
    expect(genSpan?.attributes["gen_ai.response.model"]).toBeDefined();
    expect(
      Number(genSpan?.attributes["gen_ai.usage.output_tokens"]),
    ).toBeGreaterThan(0);
    expect(genSpan?.attributes["gen_ai.output.messages"]).toBeDefined();
  });
});
