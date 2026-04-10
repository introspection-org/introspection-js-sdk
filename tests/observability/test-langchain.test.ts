import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Polly } from "@pollyjs/core";
import {
  createLangChainProvider,
  loadLangChainInstrumentation,
  CaptureOpenInferenceSpans,
} from "./fixtures";
import { simplifySpansForSnapshot } from "../testing";
import { setupPolly, ensureEnvVarsForReplay } from "../polly-setup";

describe("LangChain Dual Exporter Tests", () => {
  let capture: CaptureOpenInferenceSpans | null = null;
  let polly: Polly | null = null;

  beforeEach(async () => {
    if (!(await loadLangChainInstrumentation())) {
      console.log(
        "Skipping: OpenInference LangChain instrumentation not installed",
      );
      return;
    }

    polly = setupPolly({ recordingName: "langchain-dual-export" });

    if (
      !ensureEnvVarsForReplay(
        ["OPENAI_API_KEY", "INTROSPECTION_TOKEN", "LANGSMITH_API_KEY"],
        "langchain-dual-export",
      )
    ) {
      console.log(
        "Skipping: Required env vars not set for record/passthrough mode",
      );
      await polly.stop();
      polly = null;
      return;
    }

    capture = await createLangChainProvider();
  });

  afterEach(async () => {
    if (capture) {
      await capture.cleanup();
      capture = null;
    }
    if (polly) {
      await polly.stop();
      polly = null;
    }
  });

  it("should capture LangChain chat completion with gen_ai attributes via OpenInference", async () => {
    if (!capture) {
      return;
    }

    const { ChatOpenAI } = await import("@langchain/openai");

    const model = new ChatOpenAI({
      modelName: "gpt-5-nano",
    });

    const response = await model.invoke("Say hello in one word.");

    expect(response.content).toBeDefined();

    await capture.processor.forceFlush();
    const spans = capture.exporter.getFinishedSpans();

    expect(spans.length).toBeGreaterThan(0);

    const simplified = simplifySpansForSnapshot(spans, { normalize: true });

    expect(simplified).toMatchInlineSnapshot(
      [
        {
          trace_id: expect.any(String),
          span_id: expect.any(String),
        },
      ],
      `
        [
          {
            "attributes": {
              "gen_ai.conversation.id": "<conversation_id>",
              "gen_ai.input.messages": "[{"role":"user","parts":[{"type":"text","content":"Say hello in one word."}]}]",
              "gen_ai.operation.name": "chat",
              "gen_ai.output.messages": "<output_messages>",
              "gen_ai.request.model": "gpt-5-nano",
              "gen_ai.response.id": "<response_id>",
              "gen_ai.usage.input_tokens": "<input_tokens>",
              "gen_ai.usage.output_tokens": "<output_tokens>",
              "input.mime_type": "application/json",
              "input.value": "<input_value>",
              "metadata": "<metadata>",
              "openinference.span.kind": "LLM",
            },
            "name": "ChatOpenAI",
            "span_id": Any<String>,
            "trace_id": Any<String>,
          },
        ]
      `,
    );
  });
});
