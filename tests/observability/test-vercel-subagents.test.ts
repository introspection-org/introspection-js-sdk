/**
 * Vercel AI SDK multi-agent subagent pattern — native telemetry pathway.
 *
 * No per-call integration instance: callers enable AI SDK telemetry with
 * `experimental_telemetry: { isEnabled: true }`, and
 * IntrospectionSpanProcessor (registered globally) maps the SDK's `ai.*`
 * attributes to `gen_ai.*` via convertVercelAIToGenAI at onEnd.
 *
 *   - functionId → ai.telemetry.functionId → gen_ai.agent.name (via converter)
 *   - metadata["gen_ai.conversation.id"] →
 *     ai.telemetry.metadata.gen_ai.conversation.id → gen_ai.conversation.id
 *   - The orchestrator phases share a conversation id by reusing it on both
 *     generateText calls.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { Polly } from "@pollyjs/core";
import { IntrospectionSpanProcessor } from "@introspection-sdk/introspection-node/otel";
import {
  TestSpanExporter,
  IncrementalIdGenerator,
  simplifySpansForSnapshot,
} from "../testing";
import {
  setupPolly,
  ensureEnvVarsForReplay,
  pollyEndpoints,
  installTestOTelGlobals,
} from "../polly-setup";

describe("Vercel AI SDK Subagents — native telemetry pathway", () => {
  let exporter: TestSpanExporter | null = null;
  let provider: NodeTracerProvider | null = null;
  let polly: Polly | null = null;
  let disposeOTel: (() => void) | null = null;

  beforeAll(async () => {
    try {
      await import("ai");
      await import("@ai-sdk/openai");
    } catch {
      console.log(
        "Skipping: AI SDK packages not installed (ai, @ai-sdk/openai)",
      );
      return;
    }

    polly = setupPolly({ recordingName: "vercel-subagents" });
    if (!ensureEnvVarsForReplay(["OPENAI_API_KEY"], "vercel-subagents")) {
      console.log("Skipping: OPENAI_API_KEY missing for record/passthrough");
      await polly.stop();
      polly = null;
      return;
    }
  });

  afterAll(async () => {
    if (polly) {
      await polly.stop();
      polly = null;
    }
  });

  beforeEach(() => {
    if (!polly) return;
    disposeOTel = installTestOTelGlobals();

    exporter = new TestSpanExporter();
    provider = new NodeTracerProvider({
      idGenerator: new IncrementalIdGenerator(),
      spanProcessors: [
        new IntrospectionSpanProcessor({
          token: "test-token",
          advanced: { spanExporter: exporter, useSimpleSpanProcessor: true },
        }),
      ],
    });
    provider.register();
  });

  afterEach(async () => {
    if (provider) {
      await provider.forceFlush();
      await provider.shutdown();
      provider = null;
    }
    disposeOTel?.();
    disposeOTel = null;
    exporter = null;
  });

  it("assigns distinct agent names and conversation IDs via experimental_telemetry", async () => {
    if (!exporter || !provider) return;

    const { generateText } = await import("ai");
    const { createOpenAI } = await import("@ai-sdk/openai");
    const openai = createOpenAI({ baseURL: pollyEndpoints.openai.aiSdk });

    const ORCH_CONV_ID = "vercel-subagent-orch-test";
    const RESEARCHER_CONV_ID = "vercel-subagent-researcher-test";

    // Phase 1: orchestrator
    await generateText({
      model: openai("gpt-5-nano"),
      prompt: "Say dispatch in one word.",
      experimental_telemetry: {
        isEnabled: true,
        functionId: "orchestrator",
        metadata: { "gen_ai.conversation.id": ORCH_CONV_ID },
      },
    });

    // Phase 2: researcher
    await generateText({
      model: openai("gpt-5-nano"),
      prompt: "Say research in one word.",
      experimental_telemetry: {
        isEnabled: true,
        functionId: "researcher",
        metadata: { "gen_ai.conversation.id": RESEARCHER_CONV_ID },
      },
    });

    // Phase 3: orchestrator re-uses the same conversation ID
    await generateText({
      model: openai("gpt-5-nano"),
      prompt: "Say synthesise in one word.",
      experimental_telemetry: {
        isEnabled: true,
        functionId: "orchestrator",
        metadata: { "gen_ai.conversation.id": ORCH_CONV_ID },
      },
    });

    await provider.forceFlush();
    const all = simplifySpansForSnapshot(exporter.getFinishedSpans());

    const orchSpans = all.filter(
      (s) => s.attributes["gen_ai.agent.name"] === "orchestrator",
    );
    const researcherSpans = all.filter(
      (s) => s.attributes["gen_ai.agent.name"] === "researcher",
    );
    expect(orchSpans.length).toBeGreaterThan(0);
    expect(researcherSpans.length).toBeGreaterThan(0);

    const orchConvIds = new Set(
      orchSpans
        .map((s) => s.attributes["gen_ai.conversation.id"])
        .filter(Boolean),
    );
    expect(orchConvIds.has(ORCH_CONV_ID)).toBe(true);
    expect(orchConvIds.has(RESEARCHER_CONV_ID)).toBe(false);

    const researcherConvIds = new Set(
      researcherSpans
        .map((s) => s.attributes["gen_ai.conversation.id"])
        .filter(Boolean),
    );
    expect(researcherConvIds.has(RESEARCHER_CONV_ID)).toBe(true);
    expect(researcherConvIds.has(ORCH_CONV_ID)).toBe(false);
  });
});
