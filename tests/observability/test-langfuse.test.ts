import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Polly } from "@pollyjs/core";
import OpenAI from "openai";
import {
  createLangfuseProvider,
  loadOpenAIInstrumentation,
  CaptureOpenInferenceSpans,
} from "./fixtures";
import { simplifySpansForSnapshot, sortSpansBySpanId } from "../testing";
import { setupPolly, ensureEnvVarsForReplay } from "../polly-setup";

describe("Langfuse Dual Exporter Tests", () => {
  let capture: CaptureOpenInferenceSpans | null = null;
  let polly: Polly | null = null;

  beforeEach(async () => {
    if (!(await loadOpenAIInstrumentation())) {
      console.log(
        "Skipping: OpenInference OpenAI instrumentation not installed",
      );
      return;
    }

    polly = setupPolly({ recordingName: "langfuse-dual-export" });

    if (
      !ensureEnvVarsForReplay(
        [
          "OPENAI_API_KEY",
          "INTROSPECTION_TOKEN",
          "LANGFUSE_PUBLIC_KEY",
          "LANGFUSE_SECRET_KEY",
        ],
        "langfuse-dual-export",
      )
    ) {
      console.log(
        "Skipping: Required env vars not set for record/passthrough mode",
      );
      await polly.stop();
      polly = null;
      return;
    }

    capture = await createLangfuseProvider();
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

  it("should capture OpenAI chat completion with gen_ai attributes via OpenInference", async () => {
    if (!capture) {
      return;
    }

    const client = new OpenAI();

    const response = await client.chat.completions.create({
      model: "gpt-5-nano",
      messages: [{ role: "user", content: "Hi, how are you?" }],
    });

    expect(response.choices[0].message.content).toBeDefined();

    await capture.processor.forceFlush();
    const spans = capture.exporter.getFinishedSpans();

    expect(spans.length).toBeGreaterThan(0);

    const sortedSpans = sortSpansBySpanId(spans);
    const simplified = simplifySpansForSnapshot(sortedSpans, {
      normalize: true,
    });

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
              "gen_ai.input.messages": "[{"role":"user","parts":[{"type":"text","content":"Hi, how are you?"}]}]",
              "gen_ai.operation.name": "chat",
              "gen_ai.output.messages": "<output_messages>",
              "gen_ai.request.model": "gpt-5-nano-2025-08-07",
              "gen_ai.response.id": "<response_id>",
              "gen_ai.system": "openai",
              "gen_ai.usage.cache_read.input_tokens": 0,
              "gen_ai.usage.input_tokens": "<input_tokens>",
              "gen_ai.usage.output_tokens": "<output_tokens>",
              "input.mime_type": "application/json",
              "input.value": "<input_value>",
              "openinference.span.kind": "LLM",
            },
            "name": "OpenAI Chat Completions",
            "span_id": Any<String>,
            "trace_id": Any<String>,
          },
        ]
      `,
    );
  });
});
