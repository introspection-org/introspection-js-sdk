/**
 * Tests for the Mastra multi-agent subagent pattern.
 *
 * Covers the IntrospectionMastraExporter identity propagation used in
 * examples/otel/mastra/subagents.ts:
 *   - tracingOptions.metadata["gen_ai.conversation.id"] → per-agent conversation IDs
 *   - Separate Agent instances → distinct gen_ai.agent.name values
 *   - Orchestrator phases 1 & 3 sharing a conversation ID
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Polly } from "@pollyjs/core";
import { TestSpanExporter, simplifySpansForSnapshot } from "../testing";
import { setupPolly, ensureEnvVarsForReplay } from "../polly-setup";

describe("Mastra Subagents — per-agent conversation IDs via tracingOptions", () => {
  let exporter: TestSpanExporter | null = null;
  let polly: Polly | null = null;

  beforeEach(async () => {
    try {
      await import("@mastra/core");
      await import("@mastra/observability");
    } catch {
      console.log(
        "Skipping: Mastra packages not installed (@mastra/core, @mastra/observability)",
      );
      return;
    }

    try {
      await import("@introspection-sdk/introspection-node/mastra");
    } catch {
      console.log("Skipping: IntrospectionMastraExporter not available");
      return;
    }

    polly = setupPolly({
      recordingName: "mastra-subagents",
      adapters: ["fetch"],
    });

    if (!ensureEnvVarsForReplay(["OPENAI_API_KEY"], "mastra-subagents")) {
      console.log(
        "Skipping: Required env vars not set for record/passthrough mode",
      );
      await polly.stop();
      polly = null;
      return;
    }

    exporter = new TestSpanExporter();
  });

  afterEach(async () => {
    if (polly) {
      await polly.stop();
      polly = null;
    }
    exporter = null;
  });

  it("assigns distinct conversation IDs and agent names to different Mastra agents", async () => {
    if (!exporter) return;

    let Mastra: typeof import("@mastra/core").Mastra;
    let Agent: typeof import("@mastra/core/agent").Agent;
    let Observability: typeof import("@mastra/observability").Observability;
    let IntrospectionMastraExporter: typeof import("@introspection-sdk/introspection-node/mastra").IntrospectionMastraExporter;
    let openai: typeof import("@ai-sdk/openai").openai;

    try {
      ({ Mastra } = await import("@mastra/core"));
      ({ Agent } = await import("@mastra/core/agent"));
      ({ Observability } = await import("@mastra/observability"));
      ({ IntrospectionMastraExporter } =
        await import("@introspection-sdk/introspection-node/mastra"));
      ({ openai } = await import("@ai-sdk/openai"));
    } catch {
      console.log("Skipping: required Mastra/AI SDK packages not installed");
      return;
    }

    const introspectionExporter = new IntrospectionMastraExporter({
      advanced: { spanExporter: exporter, useSimpleSpanProcessor: true },
    });

    const observability = new Observability({
      configs: {
        otel: {
          serviceName: "mastra-subagents-test",
          exporters: [introspectionExporter],
        },
      },
    });

    const mastra = new Mastra({ observability });

    const orchestratorAgent = new Agent({
      id: "orchestrator",
      name: "orchestrator",
      instructions: "Reply in one sentence.",
      model: openai("gpt-5-nano"),
      mastra,
    });

    const researcherAgent = new Agent({
      id: "researcher",
      name: "researcher",
      instructions: "Reply in one sentence.",
      model: openai("gpt-5-nano"),
      mastra,
    });

    const ORCH_CONV_ID = "mastra-subagent-orch-test";
    const RESEARCHER_CONV_ID = "mastra-subagent-researcher-test";

    // Phase 1: orchestrator dispatches
    await orchestratorAgent.generate("Say dispatch.", {
      tracingOptions: {
        metadata: { "gen_ai.conversation.id": ORCH_CONV_ID },
      },
    });

    // Phase 2: researcher handles a task
    await researcherAgent.generate("Say research.", {
      tracingOptions: {
        metadata: { "gen_ai.conversation.id": RESEARCHER_CONV_ID },
      },
    });

    // Phase 3: orchestrator synthesises (same conversation as phase 1)
    await orchestratorAgent.generate("Say synthesise.", {
      tracingOptions: {
        metadata: { "gen_ai.conversation.id": ORCH_CONV_ID },
      },
    });

    await introspectionExporter.flush();
    await new Promise((resolve) => setTimeout(resolve, 500));

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);

    const simplified = simplifySpansForSnapshot(spans);

    // Orchestrator spans: phases 1 and 3 share ORCH_CONV_ID
    const orchSpans = simplified.filter(
      (s) => s.attributes["gen_ai.conversation.id"] === ORCH_CONV_ID,
    );
    // Researcher spans: single conversation
    const researcherSpans = simplified.filter(
      (s) => s.attributes["gen_ai.conversation.id"] === RESEARCHER_CONV_ID,
    );

    expect(orchSpans.length).toBeGreaterThan(0);
    expect(researcherSpans.length).toBeGreaterThan(0);

    // Agent names come from Agent.name, which the Mastra exporter stamps
    const orchAgentSpan = simplified.find(
      (s) => s.attributes["gen_ai.agent.name"] === "orchestrator",
    );
    const researcherAgentSpan = simplified.find(
      (s) => s.attributes["gen_ai.agent.name"] === "researcher",
    );

    expect(orchAgentSpan).toBeDefined();
    expect(researcherAgentSpan).toBeDefined();

    // Orchestrator agent spans should be linked to ORCH_CONV_ID
    expect(orchAgentSpan?.attributes["gen_ai.conversation.id"]).toBe(
      ORCH_CONV_ID,
    );

    await observability.shutdown();
  });
});
