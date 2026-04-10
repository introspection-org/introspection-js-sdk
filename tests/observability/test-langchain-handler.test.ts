import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Polly } from "@pollyjs/core";
import { TestSpanExporter, simplifySpansForSnapshot } from "../testing";
import { setupPolly, ensureEnvVarsForReplay } from "../polly-setup";

describe("LangChain First-Party Handler Tests", () => {
  let exporter: TestSpanExporter | null = null;
  let polly: Polly | null = null;

  beforeEach(async () => {
    try {
      await import("@langchain/openai");
      await import("@introspection-sdk/introspection-node/langchain");
    } catch {
      console.log(
        "Skipping: LangChain packages not installed (@langchain/openai, @langchain/core)",
      );
      return;
    }

    polly = setupPolly({ recordingName: "langchain-handler" });

    if (!ensureEnvVarsForReplay(["OPENAI_API_KEY"], "langchain-handler")) {
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

  it("should capture LangChain chat completion with gen_ai attributes via first-party handler", async () => {
    if (!exporter) {
      return;
    }

    let ChatOpenAI, IntrospectionCallbackHandler;
    try {
      ({ ChatOpenAI } = await import("@langchain/openai"));
      ({ IntrospectionCallbackHandler } =
        await import("@introspection-sdk/introspection-node/langchain"));
    } catch {
      console.log("Skipping: required LangChain packages not installed");
      return;
    }

    const handler = new IntrospectionCallbackHandler({
      advanced: {
        spanExporter: exporter,
        useSimpleSpanProcessor: true,
      },
    });

    const model = new ChatOpenAI({
      modelName: "gpt-5-nano",
    });

    const response = await model.invoke("Say hello in one word.", {
      callbacks: [handler],
    });

    expect(response.content).toBeDefined();

    await handler.forceFlush();
    const spans = exporter.getFinishedSpans();

    expect(spans.length).toBeGreaterThan(0);

    const simplified = simplifySpansForSnapshot(spans, {
      normalize: true,
    });

    // The LLM span has full gen_ai.* attributes
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
          "gen_ai.input.messages": "[{"role":"user","parts":[{"type":"text","content":"Say hello in one word."}]}]",
          "gen_ai.operation.name": "chat",
          "gen_ai.output.messages": "<output_messages>",
          "gen_ai.request.model": "gpt-5-nano",
          "gen_ai.response.id": "<response_id>",
          "gen_ai.system": "ChatOpenAI",
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

    await handler.shutdown();
  });
});
