/**
 * Unit tests for the GenAI → OpenInference (reverse) converter, the
 * `addOpenInferenceAttributes` span enricher, and `OpenInferenceSpanExporter`.
 *
 * Pure attribute transforms — no API keys, no network, no mocks. The exporter
 * test forwards to a real {@link InMemorySpanExporter}.
 */
import { describe, it, expect } from "vitest";
import type { Attributes } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { ExportResultCode } from "@opentelemetry/core";

import {
  addOpenInferenceAttributes,
  OpenInferenceSpanExporter,
  convertOpenInferenceToGenAI,
} from "../../packages/introspection-node/src/converters/openinference";

/** Build a minimal ReadableSpan carrying just the attributes under test. */
function spanWith(attributes: Attributes): ReadableSpan {
  return {
    attributes,
    spanContext: () => ({
      traceId: "0".repeat(32),
      spanId: "0".repeat(16),
      traceFlags: 1,
    }),
  } as unknown as ReadableSpan;
}

describe("addOpenInferenceAttributes", () => {
  it("maps mastra span types to openinference span kinds", () => {
    expect(
      addOpenInferenceAttributes(
        spanWith({ "mastra.span.type": "MODEL_GENERATION" }),
      ).attributes["openinference.span.kind"],
    ).toBe("LLM");
    expect(
      addOpenInferenceAttributes(spanWith({ "mastra.span.type": "AGENT_RUN" }))
        .attributes["openinference.span.kind"],
    ).toBe("CHAIN");
    expect(
      addOpenInferenceAttributes(spanWith({ "mastra.span.type": "TOOL_CALL" }))
        .attributes["openinference.span.kind"],
    ).toBe("TOOL");
    expect(
      addOpenInferenceAttributes(
        spanWith({ "mastra.span.type": "MCP_TOOL_CALL" }),
      ).attributes["openinference.span.kind"],
    ).toBe("TOOL");
  });

  it("maps model, provider, token counts and invocation params", () => {
    const out = addOpenInferenceAttributes(
      spanWith({
        "gen_ai.request.model": "gpt-4o",
        "gen_ai.provider.name": "openai",
        "gen_ai.usage.input_tokens": 10,
        "gen_ai.usage.output_tokens": 5,
        "gen_ai.request.temperature": 0.7,
        "gen_ai.request.max_tokens": 256,
        "gen_ai.request.top_p": 0.9,
      }),
    ).attributes;
    expect(out["llm.model_name"]).toBe("gpt-4o");
    expect(out["llm.provider"]).toBe("openai");
    expect(out["llm.token_count.prompt"]).toBe(10);
    expect(out["llm.token_count.completion"]).toBe(5);
    expect(out["llm.token_count.total"]).toBe(15);
    expect(JSON.parse(out["llm.invocation_parameters"] as string)).toEqual({
      temperature: 0.7,
      max_tokens: 256,
      top_p: 0.9,
    });
  });

  it("flattens gen_ai input/output messages including tool calls", () => {
    const out = addOpenInferenceAttributes(
      spanWith({
        "gen_ai.input.messages": JSON.stringify([
          { role: "user", parts: [{ type: "text", content: "hello" }] },
        ]),
        "gen_ai.output.messages": JSON.stringify([
          {
            role: "assistant",
            parts: [
              { type: "text", content: "hi" },
              {
                type: "tool_call",
                name: "lookup",
                arguments: { q: "x" },
                id: "call_1",
              },
            ],
          },
          // plain string content path
          { role: "system", content: "be brief" },
        ]),
      }),
    ).attributes;
    expect(out["llm.input_messages.0.message.role"]).toBe("user");
    expect(out["llm.input_messages.0.message.content"]).toBe("hello");
    expect(out["llm.output_messages.0.message.content"]).toBe("hi");
    expect(
      out["llm.output_messages.0.message.tool_calls.0.tool_call.function.name"],
    ).toBe("lookup");
    // non-string arguments are JSON-stringified
    expect(
      out[
        "llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments"
      ],
    ).toBe(JSON.stringify({ q: "x" }));
    expect(out["llm.output_messages.0.message.tool_calls.0.tool_call.id"]).toBe(
      "call_1",
    );
    expect(out["llm.output_messages.1.message.content"]).toBe("be brief");
  });

  it("ignores non-string / unparseable message payloads", () => {
    const out = addOpenInferenceAttributes(
      spanWith({ "gen_ai.input.messages": "{not json" }),
    ).attributes;
    expect(out["llm.input_messages.0.message.role"]).toBeUndefined();
  });

  it("maps agent-run and tool input/output values", () => {
    const agent = addOpenInferenceAttributes(
      spanWith({
        "mastra.agent_run.input": "q",
        "mastra.agent_run.output": "a",
      }),
    ).attributes;
    expect(agent["input.value"]).toBe("q");
    expect(agent["output.value"]).toBe("a");

    const tool = addOpenInferenceAttributes(
      spanWith({
        "gen_ai.tool.name": "search",
        "gen_ai.tool.description": "find things",
        "gen_ai.tool.call.arguments": '{"q":1}',
        "gen_ai.tool.call.result": "ok",
      }),
    ).attributes;
    expect(tool["tool.name"]).toBe("search");
    expect(tool["tool.description"]).toBe("find things");
    expect(tool["input.value"]).toBe('{"q":1}');
    expect(tool["output.value"]).toBe("ok");
  });
});

describe("OpenInferenceSpanExporter", () => {
  it("enriches spans before forwarding to the inner exporter", async () => {
    const inner = new InMemorySpanExporter();
    const exporter = new OpenInferenceSpanExporter(inner);
    const code = await new Promise<number>((resolve) => {
      exporter.export(
        [spanWith({ "mastra.span.type": "MODEL_GENERATION" })],
        (r) => resolve(r.code),
      );
    });
    expect(code).toBe(ExportResultCode.SUCCESS);
    const finished = inner.getFinishedSpans();
    expect(finished[0].attributes["openinference.span.kind"]).toBe("LLM");
  });

  it("delegates shutdown and forceFlush to the inner exporter", async () => {
    const inner = new InMemorySpanExporter();
    const exporter = new OpenInferenceSpanExporter(inner);
    await expect(exporter.forceFlush()).resolves.toBeUndefined();
    await expect(exporter.shutdown()).resolves.toBeUndefined();
  });
});

describe("convertOpenInferenceToGenAI — output tool calls", () => {
  it("extracts plain tool_call output messages", () => {
    const attrs: Attributes = {
      "llm.output_messages.0.message.role": "assistant",
      "llm.output_messages.0.message.tool_calls.0.tool_call.function.name":
        "get_weather",
      "llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments":
        '{"city":"NYC"}',
      "llm.output_messages.0.message.tool_calls.0.tool_call.id": "call_abc",
    };
    const result = convertOpenInferenceToGenAI(attrs);
    const parts = result.outputMessages?.[0].parts ?? [];
    const toolCall = parts.find((p) => p.type === "tool_call");
    expect(toolCall).toMatchObject({
      type: "tool_call",
      name: "get_weather",
      id: "call_abc",
    });
  });

  it("unpacks a submit_response tool call into thinking + response", () => {
    const attrs: Attributes = {
      "llm.output_messages.0.message.role": "assistant",
      "llm.output_messages.0.message.tool_calls.0.tool_call.function.name":
        "submit_response",
      "llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments":
        JSON.stringify({ thinking: "let me think", response: "the answer" }),
    };
    const result = convertOpenInferenceToGenAI(attrs);
    const texts = (result.outputMessages?.[0].parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => (p as { content?: string }).content);
    expect(texts.join(" ")).toContain("the answer");
  });

  it("falls back to raw tool_call when submit_response args are not JSON", () => {
    const attrs: Attributes = {
      "llm.output_messages.0.message.role": "assistant",
      "llm.output_messages.0.message.tool_calls.0.tool_call.function.name":
        "submit_response",
      "llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments":
        "{not-json",
    };
    const result = convertOpenInferenceToGenAI(attrs);
    const parts = result.outputMessages?.[0].parts ?? [];
    expect(parts.some((p) => p.type === "tool_call")).toBe(true);
  });
});
