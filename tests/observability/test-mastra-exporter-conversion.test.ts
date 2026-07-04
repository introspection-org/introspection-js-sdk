/**
 * Span-conversion coverage for IntrospectionMastraExporter — drives the
 * agent_run / model_step / tool_call / mcp_tool_call routing and attribute
 * mapping with realistic Mastra "span_ended" events. No mocks: spans land in a
 * real InMemorySpanExporter (SimpleSpanProcessor exports on end).
 *
 * Mastra emits children first (model_step, tool_call) and the agent_run last;
 * the exporter builds a synthetic "trace" root and ends it on agent_run.
 */
import { describe, expect, it } from "vitest";
import {
  InMemorySpanExporter,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";

import { IntrospectionMastraExporter } from "../../packages/introspection-node/src/otel/mastra-exporter";

type SpanEnded = { type: "span_ended"; exportedSpan: Record<string, unknown> };

function makeExporter() {
  const exporter = new InMemorySpanExporter();
  const mastra = new IntrospectionMastraExporter({
    advanced: { spanExporter: exporter, useSimpleSpanProcessor: true },
  });
  mastra.init({ config: { serviceName: "mastra-conv" } } as never);
  const emit = (
    mastra as unknown as {
      _exportTracingEvent: (e: SpanEnded) => Promise<void>;
    }
  )._exportTracingEvent.bind(mastra);
  const feed = (exportedSpan: Record<string, unknown>) =>
    emit({ type: "span_ended", exportedSpan });
  return { exporter, mastra, feed };
}

const TRACE = "trace-1";
const t0 = new Date("2025-01-01T00:00:00Z");
const t1 = new Date("2025-01-01T00:00:01Z");

const byName = (spans: ReadableSpan[], name: string) =>
  spans.find((s) => s.name === name);

describe("IntrospectionMastraExporter span conversion", () => {
  it("converts a full agent trace (model_step + tool calls + agent_run)", async () => {
    const { exporter, mastra, feed } = makeExporter();

    // 1) model_step — model metadata, input messages (path a), tools (path b is
    //    separate; here flat array), usage with cache details, output w/ text +
    //    reasoning + tool calls, finish reason.
    await feed({
      type: "model_step",
      traceId: TRACE,
      name: "llm",
      startTime: t0,
      endTime: t1,
      metadata: {
        modelMetadata: { modelId: "gpt-4o", modelProvider: "openai" },
        body: { model: "gpt-4o-2024", id: "resp_1" },
      },
      input: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "Weather in NYC?" },
      ],
      output: {
        text: "It's sunny.",
        reasoning: [{ text: "checking weather" }],
        toolCalls: [
          { toolName: "get_weather", toolCallId: "tc1", args: { city: "NYC" } },
        ],
      },
      attributes: {
        usage: {
          inputTokens: 30,
          outputTokens: 8,
          inputDetails: { cacheRead: 5, cacheWrite: 2 },
        },
        finishReason: "tool-calls",
      },
    });

    // 2) tool_call
    await feed({
      type: "tool_call",
      traceId: TRACE,
      name: "get_weather",
      entityName: "get_weather",
      startTime: t0,
      endTime: t1,
      input: { city: "NYC" },
      output: "sunny, 22C",
    });

    // 3) mcp_tool_call (string input/output path)
    await feed({
      type: "mcp_tool_call",
      traceId: TRACE,
      name: "search",
      entityName: "mcp__search",
      startTime: t0,
      endTime: t1,
      input: "query",
      output: { hits: 3 },
    });

    // 4) agent_run — arrives last, ends the synthetic root.
    await feed({
      type: "agent_run",
      traceId: TRACE,
      name: "weather-agent",
      entityName: "weather-agent",
      startTime: t0,
      endTime: t1,
      input: [{ role: "system", content: "Be terse." }],
      attributes: { instructions: "ignored — system came from input" },
      metadata: { "gen_ai.conversation.id": "conv_xyz", tenant: "acme" },
    });

    const spans = exporter.getFinishedSpans();

    const llm = byName(spans, "chat gpt-4o");
    expect(llm, "model_step span").toBeDefined();
    expect(llm!.attributes["gen_ai.request.model"]).toBe("gpt-4o");
    expect(llm!.attributes["gen_ai.system"]).toBe("openai");
    expect(llm!.attributes["gen_ai.response.model"]).toBe("gpt-4o-2024");
    expect(llm!.attributes["gen_ai.usage.input_tokens"]).toBe(30);
    expect(llm!.attributes["gen_ai.usage.cache_read.input_tokens"]).toBe(5);
    expect(llm!.attributes["openinference.span.kind"]).toBe("LLM");
    expect(String(llm!.attributes["gen_ai.input.messages"])).toContain(
      "Weather in NYC?",
    );
    expect(String(llm!.attributes["gen_ai.output.messages"])).toContain(
      "sunny",
    );
    expect(llm!.attributes["gen_ai.response.finish_reasons"]).toEqual([
      "tool-calls",
    ]);

    const tool = byName(spans, "get_weather");
    expect(tool, "tool_call span").toBeDefined();
    expect(tool!.attributes["gen_ai.tool.name"]).toBe("get_weather");
    expect(tool!.attributes["openinference.span.kind"]).toBe("TOOL");
    expect(tool!.attributes["gen_ai.tool.output"]).toBe("sunny, 22C");

    const mcp = byName(spans, "mcp__search");
    expect(mcp, "mcp_tool_call span").toBeDefined();
    expect(mcp!.attributes["gen_ai.tool.input"]).toBe("query");

    const root = byName(spans, "trace");
    expect(root, "synthetic root span").toBeDefined();
    expect(root!.attributes["gen_ai.conversation.id"]).toBe("conv_xyz");
    expect(root!.attributes["gen_ai.agent.name"]).toBe("weather-agent");
    expect(String(root!.attributes["gen_ai.system_instructions"])).toContain(
      "Be terse.",
    );
    expect(root!.attributes["ai.telemetry.metadata.tenant"]).toBe("acme");

    await mastra.shutdown();
  });

  it("handles the nested request-body input path + string fallbacks", async () => {
    const { exporter, mastra, feed } = makeExporter();

    await feed({
      type: "model_step",
      traceId: "trace-2",
      name: "llm",
      startTime: t0,
      endTime: t1,
      // Path (b): nested body with messages + tools
      input: {
        body: {
          messages: [{ role: "user", content: "hi" }],
          tools: [
            { type: "function", name: "f", description: "d", parameters: {} },
          ],
        },
      },
      output: "plain string output",
      attributes: {},
    });
    // agent_run with attrs.instructions fallback (no system message in input)
    await feed({
      type: "agent_run",
      traceId: "trace-2",
      name: "agent",
      startTime: t0,
      endTime: t1,
      attributes: { instructions: "You are helpful." },
    });

    const spans = exporter.getFinishedSpans();
    const llm = byName(spans, "llm");
    expect(llm).toBeDefined();
    expect(String(llm!.attributes["gen_ai.tool.definitions"])).toContain('"f"');
    expect(String(llm!.attributes["gen_ai.output.messages"])).toContain(
      "plain string output",
    );

    const root = byName(spans, "trace");
    expect(String(root!.attributes["gen_ai.system_instructions"])).toContain(
      "You are helpful.",
    );

    await mastra.shutdown();
  });

  it("ignores unknown span types", async () => {
    const { exporter, mastra, feed } = makeExporter();
    await feed({
      type: "model_generation",
      traceId: "trace-3",
      name: "x",
      startTime: t0,
      endTime: t1,
    });
    expect(exporter.getFinishedSpans()).toHaveLength(0);
    await mastra.shutdown();
  });

  it("captures provider-reported cost fields from the usage block", async () => {
    const { exporter, mastra, feed } = makeExporter();

    await feed({
      type: "model_step",
      traceId: "trace-4",
      name: "llm",
      startTime: t0,
      endTime: t1,
      metadata: { modelMetadata: { modelId: "or-model" } },
      output: { text: "hi" },
      attributes: {
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cost: 0.95,
          cost_details: { upstream_inference_cost: 0.9 },
          completion_tokens_details: { reasoning_tokens: 17 },
        },
      },
    });

    const spans = exporter.getFinishedSpans();
    const llm = byName(spans, "chat or-model");
    expect(llm, "model_step span").toBeDefined();
    expect(llm!.attributes["introspection.llm.cost_usd"]).toBe(0.95);
    expect(llm!.attributes["introspection.llm.upstream_cost_usd"]).toBe(0.9);
    expect(llm!.attributes["gen_ai.usage.reasoning_tokens"]).toBe(17);

    await mastra.shutdown();
  });

  it("emits no cost attributes when the usage cost fields are absent or non-numeric", async () => {
    const { exporter, mastra, feed } = makeExporter();

    await feed({
      type: "model_step",
      traceId: "trace-5",
      name: "llm",
      startTime: t0,
      endTime: t1,
      metadata: { modelMetadata: { modelId: "or-model" } },
      output: { text: "hi" },
      attributes: {
        usage: {
          inputTokens: 10,
          outputTokens: 2,
          cost: "0.95",
          cost_details: { upstream_inference_cost: "0.9" },
          completion_tokens_details: { reasoning_tokens: "17" },
        },
      },
    });

    const spans = exporter.getFinishedSpans();
    const llm = byName(spans, "chat or-model");
    expect(llm, "model_step span").toBeDefined();
    expect(llm!.attributes["gen_ai.usage.input_tokens"]).toBe(10);
    expect(llm!.attributes).not.toHaveProperty("introspection.llm.cost_usd");
    expect(llm!.attributes).not.toHaveProperty(
      "introspection.llm.upstream_cost_usd",
    );
    expect(llm!.attributes).not.toHaveProperty("gen_ai.usage.reasoning_tokens");

    await mastra.shutdown();
  });
});
