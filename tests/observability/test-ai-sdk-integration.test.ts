import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Polly } from "@pollyjs/core";
import { IntrospectionAISDKIntegration } from "@introspection-sdk/introspection-node";
import { TestSpanExporter, simplifySpansForSnapshot } from "../testing";
import { setupPolly, ensureEnvVarsForReplay } from "../polly-setup";

describe("AI SDK First-Party Integration Tests", () => {
  let exporter: TestSpanExporter | null = null;
  let introspection: IntrospectionAISDKIntegration | null = null;
  let polly: Polly | null = null;

  beforeEach(async () => {
    try {
      await import("ai");
      await import("@ai-sdk/openai");
    } catch {
      console.log(
        "Skipping: AI SDK packages not installed (ai, @ai-sdk/openai)",
      );
      return;
    }

    polly = setupPolly({ recordingName: "ai-sdk-integration" });

    if (!ensureEnvVarsForReplay(["OPENAI_API_KEY"], "ai-sdk-integration")) {
      console.log(
        "Skipping: Required env vars not set for record/passthrough mode",
      );
      await polly.stop();
      polly = null;
      return;
    }

    exporter = new TestSpanExporter();
    introspection = new IntrospectionAISDKIntegration({
      advanced: { spanExporter: exporter, useSimpleSpanProcessor: true },
    });
  });

  afterEach(async () => {
    if (introspection) {
      await introspection.shutdown();
      introspection = null;
    }
    if (polly) {
      await polly.stop();
      polly = null;
    }
    exporter = null;
  });

  it("should capture generateText with gen_ai attributes", async () => {
    if (!exporter || !introspection) {
      return;
    }

    let generateText, openai;
    try {
      ({ generateText } = await import("ai"));
      ({ openai } = await import("@ai-sdk/openai"));
    } catch {
      console.log("Skipping: required AI SDK packages not installed");
      return;
    }

    const { text } = await generateText({
      model: openai("gpt-5-nano"),
      system: "Reply in one word.",
      prompt: "Say hello",
      experimental_telemetry: {
        isEnabled: true,
        functionId: "test-agent",
        integrations: [introspection as any],
      },
    });

    expect(text).toBeDefined();
    expect(text.length).toBeGreaterThan(0);

    await introspection.forceFlush();
    const spans = exporter.getFinishedSpans();

    expect(spans.length).toBe(2); // root span + step span

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
          "gen_ai.agent.name": "test-agent",
          "gen_ai.conversation.id": "<conversation_id>",
          "gen_ai.input.messages": "[{"role":"user","parts":[{"type":"text","content":"Say hello"}]}]",
          "gen_ai.operation.name": "chat",
          "gen_ai.output.messages": "<output_messages>",
          "gen_ai.request.model": "gpt-5-nano",
          "gen_ai.response.finish_reasons": [
            "stop",
          ],
          "gen_ai.response.id": "<response_id>",
          "gen_ai.response.model": "<response_model>",
          "gen_ai.system": "openai.responses",
          "gen_ai.system_instructions": "[{"type":"text","content":"Reply in one word."}]",
          "gen_ai.usage.cache_read.input_tokens": 0,
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

    // The root span groups the generation
    const rootSpan = simplified.find(
      (s) =>
        s.attributes["gen_ai.agent.name"] === "test-agent" &&
        !s.attributes["gen_ai.operation.name"],
    );
    expect(rootSpan).toBeDefined();
    expect(rootSpan!.attributes["gen_ai.conversation.id"]).toBe(
      chatSpan!.attributes["gen_ai.conversation.id"],
    );
  });
});
