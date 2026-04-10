/**
 * Tests for Anthropic extended thinking with AnthropicInstrumentor.
 *
 * Records actual Anthropic API responses to validate that thinking blocks
 * (with content + signature) are correctly captured in gen_ai spans.
 *
 * Uses AnthropicInstrumentor (not OpenInference) since those drop thinking blocks.
 */

import { describe, it, expect } from "vitest";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  AnthropicInstrumentor,
  IntrospectionSpanProcessor,
} from "@introspection-sdk/introspection-node";
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
 * Extends the shared normalize by also normalizing gen_ai.input.messages
 * (multi-turn inputs contain long thinking blocks + signatures).
 */
function normalizeSpans(spans: ReturnType<typeof simplifySpansForSnapshot>) {
  return simplifySpansForSnapshot(sortSpansBySpanId(spans as any) as any, {
    normalize: true,
  }).map((s) => {
    const attrs = { ...s.attributes };
    // Normalize long input messages (multi-turn with thinking blocks)
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

  if (!ensureEnvVarsForReplay(["ANTHROPIC_API_KEY"], recordingName)) {
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

  const instrumentor = new AnthropicInstrumentor();

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

describe("Anthropic Thinking Tests", () => {
  it("should capture thinking blocks with content and signature (non-streaming)", async () => {
    const h = createHarness("anthropic-thinking-basic");
    if (!h) return;

    try {
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const client = new Anthropic();
      h.instrumentor.instrument({ tracerProvider: h.provider, client });

      const response = (await client.messages.create({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 8000,
        thinking: { type: "enabled", budget_tokens: 5000 },
        messages: [
          { role: "user", content: "What is 2+2? Think step by step." },
        ],
      })) as any;

      // Verify the response has thinking + text blocks
      expect(
        response.content.filter((b: any) => b.type === "thinking").length,
      ).toBeGreaterThanOrEqual(1);
      expect(
        response.content.filter((b: any) => b.type === "text").length,
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
                "gen_ai.provider.name": "anthropic",
                "gen_ai.request.model": "claude-sonnet-4-5-20250929",
                "gen_ai.response.id": "<response_id>",
                "gen_ai.response.model": "<response_model>",
                "gen_ai.system": "anthropic",
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

      // Verify thinking parts in output (normalized away in snapshot)
      const outputMsgs = parseJsonAttr(
        spans[0].attributes["gen_ai.output.messages"],
      ) as any[];
      const thinkingParts = outputMsgs[0].parts.filter(
        (p: any) => p.type === "thinking",
      );
      expect(thinkingParts.length).toBeGreaterThanOrEqual(1);
      expect(thinkingParts[0].content).toEqual(expect.any(String));
      expect(thinkingParts[0].content.length).toBeGreaterThan(0);
      expect(thinkingParts[0].signature).toEqual(expect.any(String));
      expect(thinkingParts[0].signature.length).toBeGreaterThan(0);
      expect(thinkingParts[0].provider_name).toBe("anthropic");
    } finally {
      await h.cleanup();
    }
  });

  it("should capture multi-turn with tool call and Fahrenheit conversion", async () => {
    const h = createHarness("anthropic-thinking-multi-turn");
    if (!h) return;

    try {
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const client = new Anthropic();
      h.instrumentor.instrument({ tracerProvider: h.provider, client });

      const tools = [
        {
          name: "get_weather",
          description:
            "Get weather for a city. Returns conditions and temperature in Celsius.",
          input_schema: {
            type: "object" as const,
            properties: {
              city: { type: "string", description: "City name" },
            },
            required: ["city"],
          },
        },
      ];

      const messages: any[] = [
        { role: "user", content: "What is the weather in Tokyo?" },
      ];

      // Turn 1: thinking + tool call
      const response1 = (await client.messages.create({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 8000,
        thinking: { type: "enabled", budget_tokens: 5000 },
        tools,
        messages,
      })) as any;

      const toolUseBlocks = response1.content.filter(
        (b: any) => b.type === "tool_use",
      );
      expect(toolUseBlocks.length).toBeGreaterThanOrEqual(1);

      messages.push({ role: "assistant", content: response1.content });
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: toolUseBlocks[0].id,
            content: "Clear, 25\u00b0C",
          },
        ],
      });

      // Turn 2: model summarizes tool result
      const response2 = (await client.messages.create({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 8000,
        thinking: { type: "enabled", budget_tokens: 5000 },
        tools,
        messages,
      })) as any;

      expect(
        response2.content.filter((b: any) => b.type === "text").length,
      ).toBeGreaterThanOrEqual(1);

      messages.push({ role: "assistant", content: response2.content });
      messages.push({
        role: "user",
        content: "What is that temperature in Fahrenheit?",
      });

      // Turn 3: model reasons over previous output to convert 25C -> ~77F
      const response3 = (await client.messages.create({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 8000,
        thinking: { type: "enabled", budget_tokens: 5000 },
        messages,
      })) as any;

      const textBlocks3 = response3.content.filter(
        (b: any) => b.type === "text",
      );
      expect(textBlocks3.length).toBeGreaterThanOrEqual(1);

      // Verify the model's answer is close to 77F (25C = 77F)
      const answerText = textBlocks3[0].text || "";
      const fahrenheitMatch = answerText.match(/(\d+(?:\.\d+)?)\s*°?F/);
      expect(fahrenheitMatch).toBeTruthy();
      const fahrenheitValue = parseFloat(fahrenheitMatch![1]);
      expect(Math.abs(fahrenheitValue - 77.0)).toBeLessThanOrEqual(2.0);

      await h.provider.forceFlush();
      const spans = h.exporter.getFinishedSpans();
      expect(spans.length).toBeGreaterThanOrEqual(3);

      const simplified = normalizeSpans(spans);
      expect(simplified).toMatchInlineSnapshot(
        [
          { trace_id: expect.any(String), span_id: expect.any(String) },
          { trace_id: expect.any(String), span_id: expect.any(String) },
          { trace_id: expect.any(String), span_id: expect.any(String) },
        ],
        `
          [
            {
              "attributes": {
                "gen_ai.conversation.id": "<conversation_id>",
                "gen_ai.input.messages": "[{"role":"user","parts":[{"type":"text","content":"What is the weather in Tokyo?"}]}]",
                "gen_ai.operation.name": "chat",
                "gen_ai.output.messages": "<output_messages>",
                "gen_ai.provider.name": "anthropic",
                "gen_ai.request.model": "claude-sonnet-4-5-20250929",
                "gen_ai.response.id": "<response_id>",
                "gen_ai.response.model": "<response_model>",
                "gen_ai.system": "anthropic",
                "gen_ai.tool.definitions": "[{"name":"get_weather","description":"Get weather for a city. Returns conditions and temperature in Celsius.","parameters":{"type":"object","properties":{"city":{"type":"string","description":"City name"}},"required":["city"]}}]",
                "gen_ai.usage.input_tokens": "<input_tokens>",
                "gen_ai.usage.output_tokens": "<output_tokens>",
                "openinference.span.kind": "LLM",
              },
              "name": "chat",
              "span_id": Any<String>,
              "trace_id": Any<String>,
            },
            {
              "attributes": {
                "gen_ai.conversation.id": "<conversation_id>",
                "gen_ai.input.messages": "<input_messages>",
                "gen_ai.operation.name": "chat",
                "gen_ai.output.messages": "<output_messages>",
                "gen_ai.provider.name": "anthropic",
                "gen_ai.request.model": "claude-sonnet-4-5-20250929",
                "gen_ai.response.id": "<response_id>",
                "gen_ai.response.model": "<response_model>",
                "gen_ai.system": "anthropic",
                "gen_ai.tool.definitions": "[{"name":"get_weather","description":"Get weather for a city. Returns conditions and temperature in Celsius.","parameters":{"type":"object","properties":{"city":{"type":"string","description":"City name"}},"required":["city"]}}]",
                "gen_ai.usage.input_tokens": "<input_tokens>",
                "gen_ai.usage.output_tokens": "<output_tokens>",
                "openinference.span.kind": "LLM",
              },
              "name": "chat",
              "span_id": Any<String>,
              "trace_id": Any<String>,
            },
            {
              "attributes": {
                "gen_ai.conversation.id": "<conversation_id>",
                "gen_ai.input.messages": "<input_messages>",
                "gen_ai.operation.name": "chat",
                "gen_ai.output.messages": "<output_messages>",
                "gen_ai.provider.name": "anthropic",
                "gen_ai.request.model": "claude-sonnet-4-5-20250929",
                "gen_ai.response.id": "<response_id>",
                "gen_ai.response.model": "<response_model>",
                "gen_ai.system": "anthropic",
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

      // Verify thinking blocks in detail (normalized away in snapshot)
      // Turn 1: thinking + tool_call
      const turn1Output = parseJsonAttr(
        spans[0].attributes["gen_ai.output.messages"],
      ) as any[];
      expect(turn1Output[0].finish_reason).toBe("tool-calls");
      expect(
        turn1Output[0].parts.filter((p: any) => p.type === "thinking").length,
      ).toBeGreaterThanOrEqual(1);

      // Turn 2 input: should contain thinking blocks from history
      const turn2Input = parseJsonAttr(
        spans[1].attributes["gen_ai.input.messages"],
      ) as any[];
      const assistantParts: any[] = [];
      for (const msg of turn2Input) {
        if (msg.role === "assistant") {
          assistantParts.push(...(msg.parts || []));
        }
      }
      expect(
        assistantParts.filter((p: any) => p.type === "thinking").length,
      ).toBeGreaterThanOrEqual(1);

      // Turn 3 output: thinking (model reasoning about conversion)
      const turn3Output = parseJsonAttr(
        spans[2].attributes["gen_ai.output.messages"],
      ) as any[];
      expect(turn3Output[0].finish_reason).toBe("stop");
      expect(
        turn3Output[0].parts.filter((p: any) => p.type === "thinking").length,
      ).toBeGreaterThanOrEqual(1);
    } finally {
      await h.cleanup();
    }
  });

  it("should capture thinking blocks from streaming response", async () => {
    const h = createHarness("anthropic-thinking-streaming");
    if (!h) return;

    try {
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const client = new Anthropic();
      h.instrumentor.instrument({ tracerProvider: h.provider, client });

      const stream = (await client.messages.create({
        model: "claude-sonnet-4-5-20250929",
        max_tokens: 8000,
        stream: true,
        thinking: { type: "enabled", budget_tokens: 5000 },
        messages: [{ role: "user", content: "What is 3+3?" }],
      })) as AsyncIterable<any>;

      // Consume the stream
      const chunks: any[] = [];
      for await (const event of stream) {
        chunks.push(event);
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
                "gen_ai.provider.name": "anthropic",
                "gen_ai.request.model": "claude-sonnet-4-5-20250929",
                "gen_ai.response.id": "<response_id>",
                "gen_ai.response.model": "<response_model>",
                "gen_ai.system": "anthropic",
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

      // Verify thinking parts in output (normalized away in snapshot)
      const outputMsgs = parseJsonAttr(
        spans[0].attributes["gen_ai.output.messages"],
      ) as any[];
      const thinkingParts = outputMsgs[0].parts.filter(
        (p: any) => p.type === "thinking",
      );
      expect(thinkingParts.length).toBeGreaterThanOrEqual(1);
      expect(thinkingParts[0].content).toEqual(expect.any(String));
      expect(thinkingParts[0].content.length).toBeGreaterThan(0);
      expect(thinkingParts[0].signature).toEqual(expect.any(String));
      expect(thinkingParts[0].signature.length).toBeGreaterThan(0);
      expect(thinkingParts[0].provider_name).toBe("anthropic");
    } finally {
      await h.cleanup();
    }
  });
});
