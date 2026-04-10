import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Polly } from "@pollyjs/core";
import {
  createVercelProvider,
  loadVercelOpenInference,
  CaptureVercelSpans,
} from "./fixtures";
import { simplifySpansForSnapshot, sortSpansBySpanId } from "../testing";
import { setupPolly, ensureEnvVarsForReplay } from "../polly-setup";

describe("Vercel AI SDK Dual Exporter Tests", () => {
  let capture: CaptureVercelSpans | null = null;
  let polly: Polly | null = null;

  beforeEach(async () => {
    if (!(await loadVercelOpenInference())) {
      console.log("Skipping: OpenInference Vercel not installed");
      return;
    }

    polly = setupPolly({ recordingName: "vercel-dual-export" });

    if (
      !ensureEnvVarsForReplay(
        [
          "OPENAI_API_KEY",
          "INTROSPECTION_TOKEN",
          "ARIZE_SPACE_KEY",
          "ARIZE_API_KEY",
        ],
        "vercel-dual-export",
      )
    ) {
      console.log(
        "Skipping: Required env vars not set for record/passthrough mode",
      );
      await polly.stop();
      polly = null;
      return;
    }

    capture = await createVercelProvider();
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

  it("should capture Vercel AI SDK generateText with gen_ai attributes", async () => {
    if (!capture) {
      return;
    }

    let generateText, openai;
    try {
      ({ generateText } = await import("ai"));
      ({ openai } = await import("@ai-sdk/openai"));
    } catch {
      console.log("Skipping: required Vercel AI SDK packages not installed");
      return;
    }

    const { text } = await generateText({
      model: openai("gpt-5-nano"),
      prompt: "What is the weather in Boston?",
      experimental_telemetry: { isEnabled: true },
    });

    expect(text).toBeDefined();
    expect(text.length).toBeGreaterThan(0);

    await capture.vercelProcessor.forceFlush();
    await capture.provider.forceFlush();
    const spans = capture.exporter.getFinishedSpans();

    expect(spans.length).toBeGreaterThan(0);

    const sortedSpans = sortSpansBySpanId(spans);
    const simplified = simplifySpansForSnapshot(sortedSpans, {
      normalize: true,
    });

    // The LLM span (chat) has full gen_ai.* attributes from the PR branch
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
          "ai.model.id": "gpt-5-nano",
          "ai.model.provider": "openai.responses",
          "ai.operationId": "ai.generateText.doGenerate",
          "ai.prompt.messages": "[{"role":"user","content":[{"type":"text","text":"What is the weather in Boston?"}]}]",
          "ai.request.headers.user-agent": "ai/6.0.78",
          "ai.response.finishReason": "stop",
          "ai.response.id": "<response_id>",
          "ai.response.model": "<response_model>",
          "ai.response.providerMetadata": "<provider_metadata>",
          "ai.response.reasoning": "",
          "ai.response.text": "<response_text>",
          "ai.response.timestamp": "<timestamp>",
          "ai.settings.maxRetries": 2,
          "ai.usage.completionTokens": "<output_tokens>",
          "ai.usage.promptTokens": "<input_tokens>",
          "gen_ai.input.messages": "[{"role":"user","parts":[]}]",
          "gen_ai.operation.name": "chat",
          "gen_ai.output.messages": "<output_messages>",
          "gen_ai.provider.name": "openai.responses",
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
          "operation.name": "ai.generateText.doGenerate",
        },
        "name": "chat gpt-5-nano",
        "span_id": Any<String>,
        "trace_id": Any<String>,
      }
    `,
    );

    // The CHAIN span wraps the full generateText call
    const chainSpan = simplified.find(
      (s) => s.attributes["openinference.span.kind"] === "CHAIN",
    );
    expect(chainSpan).toBeDefined();
    expect(chainSpan!.attributes["ai.model.id"]).toBe("gpt-5-nano");
    expect(chainSpan!.name).toBe("ai.generateText");
  });
});
