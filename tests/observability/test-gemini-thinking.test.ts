/**
 * Tests for Gemini thought signatures with GeminiInstrumentor.
 *
 * Records actual Gemini API responses (via Polly HARs) to validate that
 * thought summaries (`thought: true`) and per-part `thoughtSignature` payloads
 * are correctly captured as `thinking` parts on gen_ai spans.
 *
 * Uses GeminiInstrumentor since no third-party instrumentor preserves
 * thought signatures end-to-end.
 */

import { describe, it, expect } from "vitest";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  GeminiInstrumentor,
  IntrospectionSpanProcessor,
} from "@introspection-sdk/introspection-node/otel";
import {
  TestSpanExporter,
  IncrementalIdGenerator,
  parseJsonAttr,
  simplifySpansForSnapshot,
  sortSpansBySpanId,
} from "../testing";
import { setupPolly, ensureEnvVarsForReplay } from "../polly-setup";

/**
 * Normalize spans for snapshot: replaces dynamic values with placeholders.
 * Extends the shared normalize by also collapsing the long input messages
 * (multi-turn inputs contain long thought signatures).
 */
function normalizeSpans(spans: ReturnType<typeof simplifySpansForSnapshot>) {
  return simplifySpansForSnapshot(sortSpansBySpanId(spans as any) as any, {
    normalize: true,
  }).map((s) => {
    const attrs = { ...s.attributes };
    if (
      typeof attrs["gen_ai.input.messages"] === "string" &&
      (attrs["gen_ai.input.messages"] as string).length > 200
    ) {
      attrs["gen_ai.input.messages"] = "<input_messages>";
    }
    return { ...s, attributes: attrs };
  });
}

/** Create a fresh test harness with its own Polly recording. */
function createHarness(recordingName: string) {
  const polly = setupPolly({ recordingName });

  if (!ensureEnvVarsForReplay(["GEMINI_API_KEY"], recordingName)) {
    return null;
  }

  const exporter = new TestSpanExporter();
  const processor = new IntrospectionSpanProcessor({
    token: "test-token",
    advanced: {
      spanExporter: exporter,
      useSimpleSpanProcessor: true,
    },
  });

  const provider = new NodeTracerProvider({
    idGenerator: new IncrementalIdGenerator(),
    spanProcessors: [processor],
  });
  provider.register();

  const instrumentor = new GeminiInstrumentor();

  return {
    exporter,
    provider,
    instrumentor,
    polly,
    async cleanup() {
      instrumentor.uninstrument();
      await provider.forceFlush();
      await provider.shutdown();
      await polly.stop();
    },
  };
}

describe("Gemini Thinking Tests", () => {
  it("captures thought summary parts with content and provider_name (non-streaming)", async () => {
    const h = createHarness("gemini-thinking-basic");
    if (!h) return;

    try {
      const { GoogleGenAI } = await import("@google/genai");
      const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      h.instrumentor.instrument({ tracerProvider: h.provider, client });

      const response = await client.models.generateContent({
        model: "gemini-2.5-flash",
        contents: "What is 2+2? Think step by step.",
        config: {
          thinkingConfig: { thinkingBudget: 2048, includeThoughts: true },
        },
      });

      const parts = response.candidates?.[0]?.content?.parts ?? [];
      expect(
        parts.filter((p: any) => p.thought === true).length,
      ).toBeGreaterThanOrEqual(1);
      expect(
        parts.filter((p: any) => typeof p.text === "string" && !p.thought)
          .length,
      ).toBeGreaterThanOrEqual(1);

      await h.provider.forceFlush();
      const spans = h.exporter.getFinishedSpans();
      expect(spans.length).toBeGreaterThanOrEqual(1);

      const simplified = normalizeSpans(spans);
      expect(simplified).toMatchInlineSnapshot(
        [{ trace_id: expect.any(String), span_id: expect.any(String) }],
        `
          [
            {
              "attributes": {
                "gen_ai.conversation.id": "<conversation_id>",
                "gen_ai.input.messages": "[{"role":"user","parts":[{"type":"text","content":"What is 2+2? Think step by step."}]}]",
                "gen_ai.operation.name": "chat",
                "gen_ai.output.messages": "<output_messages>",
                "gen_ai.provider.name": "gemini",
                "gen_ai.request.model": "gemini-2.5-flash",
                "gen_ai.response.finish_reasons": [
                  "STOP",
                ],
                "gen_ai.response.id": "<response_id>",
                "gen_ai.response.model": "<response_model>",
                "gen_ai.system": "gemini",
                "gen_ai.usage.input_tokens": "<input_tokens>",
                "gen_ai.usage.output_tokens": "<output_tokens>",
                "openinference.span.kind": "LLM",
              },
              "name": "chat",
              "span_id": Any<String>,
              "trace_id": Any<String>,
            },
          ]
        `,
      );

      const outputMsgs = parseJsonAttr(
        spans[0].attributes["gen_ai.output.messages"],
      ) as any[];
      const thinkingParts = outputMsgs[0].parts.filter(
        (p: any) => p.type === "thinking",
      );
      expect(thinkingParts.length).toBeGreaterThanOrEqual(1);
      expect(thinkingParts[0].content).toEqual(expect.any(String));
      expect(thinkingParts[0].content.length).toBeGreaterThan(0);
      expect(thinkingParts[0].provider_name).toBe("gemini");

      const textParts = outputMsgs[0].parts.filter(
        (p: any) => p.type === "text",
      );
      expect(textParts.length).toBeGreaterThanOrEqual(1);
      expect(textParts[0].content).toEqual(expect.any(String));
    } finally {
      await h.cleanup();
    }
  });

  it("captures thoughtSignature on function-call parts as redacted thinking", async () => {
    const h = createHarness("gemini-thinking-tool-call");
    if (!h) return;

    try {
      const { GoogleGenAI, Type } = await import("@google/genai");
      const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      h.instrumentor.instrument({ tracerProvider: h.provider, client });

      const tools = [
        {
          functionDeclarations: [
            {
              name: "get_current_temperature",
              description: "Get the current temperature in a given city.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  city: { type: Type.STRING, description: "City name" },
                },
                required: ["city"],
              },
            },
          ],
        },
      ];

      const response = await client.models.generateContent({
        model: "gemini-2.5-flash",
        contents:
          "What is the current temperature in Paris and London? Use the tool for both.",
        config: {
          tools,
          thinkingConfig: { thinkingBudget: 1024, includeThoughts: true },
        },
      });

      const parts = response.candidates?.[0]?.content?.parts ?? [];
      const functionCallParts = parts.filter((p: any) => p.functionCall);
      expect(functionCallParts.length).toBeGreaterThanOrEqual(1);
      const signedParts = parts.filter((p: any) => p.thoughtSignature);
      expect(signedParts.length).toBeGreaterThanOrEqual(1);

      await h.provider.forceFlush();
      const spans = h.exporter.getFinishedSpans();
      expect(spans.length).toBeGreaterThanOrEqual(1);

      const outputMsgs = parseJsonAttr(
        spans[0].attributes["gen_ai.output.messages"],
      ) as any[];
      const outParts = outputMsgs[0].parts;

      // At least one thinking part carrying "[redacted]" + signature should be present,
      // emitted just before a tool_call (the part the signature was attached to).
      const redactedThinking = outParts.filter(
        (p: any) =>
          p.type === "thinking" &&
          p.content === "[redacted]" &&
          typeof p.signature === "string" &&
          p.signature.length > 0,
      );
      expect(redactedThinking.length).toBeGreaterThanOrEqual(1);
      expect(redactedThinking[0].provider_name).toBe("gemini");

      const toolCalls = outParts.filter((p: any) => p.type === "tool_call");
      expect(toolCalls.length).toBeGreaterThanOrEqual(2);
      expect(toolCalls[0].name).toBe("get_current_temperature");
      expect(toolCalls[0].arguments).toEqual({ city: expect.any(String) });

      // Tool definitions are captured
      const toolDefs = parseJsonAttr(
        spans[0].attributes["gen_ai.tool.definitions"],
      ) as any[];
      expect(toolDefs[0].name).toBe("get_current_temperature");
    } finally {
      await h.cleanup();
    }
  });

  it("captures thinking summary from streaming response", async () => {
    const h = createHarness("gemini-thinking-streaming");
    if (!h) return;

    try {
      const { GoogleGenAI } = await import("@google/genai");
      const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      h.instrumentor.instrument({ tracerProvider: h.provider, client });

      const stream = await client.models.generateContentStream({
        model: "gemini-2.5-flash",
        contents: "What is 3+3?",
        config: {
          thinkingConfig: { thinkingBudget: 512, includeThoughts: true },
        },
      });

      const chunks: any[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThan(0);

      await h.provider.forceFlush();
      const spans = h.exporter.getFinishedSpans();
      expect(spans.length).toBeGreaterThanOrEqual(1);

      const simplified = normalizeSpans(spans);
      expect(simplified).toMatchInlineSnapshot(
        [{ trace_id: expect.any(String), span_id: expect.any(String) }],
        `
          [
            {
              "attributes": {
                "gen_ai.conversation.id": "<conversation_id>",
                "gen_ai.input.messages": "[{"role":"user","parts":[{"type":"text","content":"What is 3+3?"}]}]",
                "gen_ai.operation.name": "chat",
                "gen_ai.output.messages": "<output_messages>",
                "gen_ai.provider.name": "gemini",
                "gen_ai.request.model": "gemini-2.5-flash",
                "gen_ai.response.finish_reasons": [
                  "STOP",
                ],
                "gen_ai.response.id": "<response_id>",
                "gen_ai.response.model": "<response_model>",
                "gen_ai.system": "gemini",
                "gen_ai.usage.input_tokens": "<input_tokens>",
                "gen_ai.usage.output_tokens": "<output_tokens>",
                "openinference.span.kind": "LLM",
              },
              "name": "chat",
              "span_id": Any<String>,
              "trace_id": Any<String>,
            },
          ]
        `,
      );

      const outputMsgs = parseJsonAttr(
        spans[0].attributes["gen_ai.output.messages"],
      ) as any[];
      const thinkingParts = outputMsgs[0].parts.filter(
        (p: any) => p.type === "thinking",
      );
      expect(thinkingParts.length).toBeGreaterThanOrEqual(1);
      expect(thinkingParts[0].provider_name).toBe("gemini");
      const textParts = outputMsgs[0].parts.filter(
        (p: any) => p.type === "text",
      );
      expect(textParts.length).toBeGreaterThanOrEqual(1);
    } finally {
      await h.cleanup();
    }
  });

  it("captures multi-turn tool call with thought-signature replay across turns", async () => {
    const h = createHarness("gemini-thinking-multi-turn");
    if (!h) return;

    try {
      const { GoogleGenAI, Type } = await import("@google/genai");
      const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      h.instrumentor.instrument({ tracerProvider: h.provider, client });

      const tools = [
        {
          functionDeclarations: [
            {
              name: "get_weather",
              description:
                "Get the current weather for a city. Returns conditions and temperature in Celsius.",
              parameters: {
                type: Type.OBJECT,
                properties: {
                  city: { type: Type.STRING, description: "City name" },
                },
                required: ["city"],
              },
            },
          ],
        },
      ];

      const contents: any[] = [
        { role: "user", parts: [{ text: "What is the weather in Tokyo?" }] },
      ];

      // Turn 1: model emits a thoughtSignature on the function-call part
      const turn1 = await client.models.generateContent({
        model: "gemini-2.5-flash",
        contents,
        config: {
          tools,
          thinkingConfig: { thinkingBudget: 1024, includeThoughts: true },
        },
      });

      const turn1Parts = turn1.candidates?.[0]?.content?.parts ?? [];
      const fnCall = turn1Parts.find((p: any) => p.functionCall);
      expect(fnCall?.functionCall?.name).toBe("get_weather");

      // Replay the full assistant content (preserving thoughtSignature) plus
      // the tool result back into `contents` for the next turn.
      contents.push({ role: "model", parts: turn1Parts });
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "get_weather",
              response: { conditions: "Clear", temperature_c: 25 },
            },
          },
        ],
      });

      // Turn 2: model uses the tool result to answer
      const turn2 = await client.models.generateContent({
        model: "gemini-2.5-flash",
        contents,
        config: {
          tools,
          thinkingConfig: { thinkingBudget: 1024, includeThoughts: true },
        },
      });

      const turn2Text = (turn2.candidates?.[0]?.content?.parts ?? [])
        .filter((p: any) => p.text && !p.thought)
        .map((p: any) => p.text)
        .join("");
      expect(turn2Text.toLowerCase()).toMatch(/tokyo|clear|25/);

      await h.provider.forceFlush();
      const spans = h.exporter.getFinishedSpans();
      expect(spans.length).toBeGreaterThanOrEqual(2);

      // Turn 1 output: should carry a redacted thinking part + tool_call
      const turn1Output = parseJsonAttr(
        spans[0].attributes["gen_ai.output.messages"],
      ) as any[];
      expect(
        turn1Output[0].parts.filter((p: any) => p.type === "thinking").length,
      ).toBeGreaterThanOrEqual(1);
      expect(
        turn1Output[0].parts.filter((p: any) => p.type === "tool_call").length,
      ).toBeGreaterThanOrEqual(1);

      // Turn 2 input: the replayed assistant content must include the
      // thinking part (with the signature) carried over from turn 1.
      const turn2Input = parseJsonAttr(
        spans[1].attributes["gen_ai.input.messages"],
      ) as any[];
      const replayedAssistantParts = turn2Input
        .filter((m: any) => m.role === "assistant")
        .flatMap((m: any) => m.parts);
      const replayedThinking = replayedAssistantParts.filter(
        (p: any) => p.type === "thinking",
      );
      expect(replayedThinking.length).toBeGreaterThanOrEqual(1);
      expect(
        replayedThinking.every((p: any) => p.provider_name === "gemini"),
      ).toBe(true);
      // At least one thinking part carries the actual thought signature
      // (Gemini attaches the signature to the function-call part, which the
      // converter surfaces as a "[redacted]" thinking part preceding the tool_call).
      const withSignature = replayedThinking.filter(
        (p: any) => typeof p.signature === "string" && p.signature.length > 0,
      );
      expect(withSignature.length).toBeGreaterThanOrEqual(1);
      expect(withSignature[0].content).toBe("[redacted]");
    } finally {
      await h.cleanup();
    }
  });
});
