import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Polly } from "@pollyjs/core";
import { TestSpanExporter, simplifySpansForSnapshot } from "../testing";
import { setupPolly, ensureEnvVarsForReplay } from "../polly-setup";

describe("Mastra First-Party Exporter Tests", () => {
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

    // Only intercept fetch (OpenAI calls); let node-http through
    polly = setupPolly({
      recordingName: "mastra-exporter",
      adapters: ["fetch"],
    });

    if (!ensureEnvVarsForReplay(["OPENAI_API_KEY"], "mastra-exporter")) {
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

  it("should capture Mastra agent generation with gen_ai attributes via IntrospectionMastraExporter", async () => {
    if (!exporter) {
      return;
    }

    let Mastra, Agent, Observability, IntrospectionMastraExporter, openai;
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
      advanced: {
        spanExporter: exporter,
        useSimpleSpanProcessor: true,
      },
    });

    const observability = new Observability({
      configs: {
        otel: {
          serviceName: "mastra-exporter-test",
          exporters: [introspectionExporter],
        },
      },
    });

    const mastra = new Mastra({ observability });

    const agent = new Agent({
      id: "test-agent",
      name: "test-agent",
      instructions: "You are a helpful assistant. Reply in one sentence.",
      model: openai("gpt-5-nano"),
      mastra,
    });

    const result = await agent.generate("Say hello in one word.");

    expect(result.text).toBeDefined();
    expect(result.text.length).toBeGreaterThan(0);

    await introspectionExporter.flush();
    // Give spans a moment to flow through the pipeline
    await new Promise((resolve) => setTimeout(resolve, 500));

    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBeGreaterThan(0);

    const simplified = simplifySpansForSnapshot(spans, { normalize: true });

    // The LLM step span has full gen_ai.* attributes
    const chatSpan = simplified.find(
      (s) => s.attributes["gen_ai.operation.name"] === "chat",
    );
    expect(chatSpan).toBeDefined();
    expect(chatSpan).toMatchInlineSnapshot(
      {
        trace_id: expect.any(String),
        span_id: expect.any(String),
      },
      `
      {
        "attributes": {
          "gen_ai.conversation.id": "<conversation_id>",
          "gen_ai.input.messages": "[{"role":"developer","parts":[{"type":"text","content":"You are a helpful assistant. Reply in one sentence."}]},{"role":"user","parts":[{"type":"text","content":"Say hello in one word."}]}]",
          "gen_ai.operation.name": "chat",
          "gen_ai.output.messages": "<output_messages>",
          "gen_ai.request.model": "gpt-5-nano",
          "gen_ai.response.finish_reasons": [
            "stop",
          ],
          "gen_ai.response.id": "<response_id>",
          "gen_ai.response.model": "<response_model>",
          "gen_ai.system": "openai.responses",
          "gen_ai.usage.input_tokens": "<input_tokens>",
          "gen_ai.usage.output_tokens": "<output_tokens>",
          "openinference.span.kind": "LLM",
        },
        "name": "chat gpt-5-nano",
        "span_id": Any<String>,
        "trace_id": Any<String>,
      }
    `,
    );

    // The agent root span
    const agentSpan = simplified.find(
      (s) =>
        s.attributes["gen_ai.agent.name"] === "test-agent" &&
        !s.attributes["gen_ai.operation.name"],
    );
    expect(agentSpan).toBeDefined();
    expect(agentSpan!.attributes["gen_ai.system_instructions"]).toBeDefined();

    // All spans share the same conversation ID
    const convIds = new Set(
      simplified
        .map((s) => s.attributes["gen_ai.conversation.id"])
        .filter(Boolean),
    );
    expect(convIds.size).toBe(1);

    await observability.shutdown();
  });
});
