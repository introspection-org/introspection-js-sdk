/**
 * Shape-variety coverage for IntrospectionMastraExporter's message normalizers
 * (_convertInput / _convertOutput / _extractParts / _extractTextContent) and the
 * "optional field absent" branches of the converters. Mastra/AI-SDK emit many
 * content formats across versions; these fixtures drive the format branches that
 * a single happy-path trace doesn't reach. No mocks — real InMemorySpanExporter.
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
  mastra.init({ config: { serviceName: "mastra-shapes" } } as never);
  const feed = (exportedSpan: Record<string, unknown>) =>
    (
      mastra as unknown as {
        _exportTracingEvent: (e: SpanEnded) => Promise<void>;
      }
    )._exportTracingEvent({ type: "span_ended", exportedSpan });
  return { exporter, mastra, feed };
}

const t0 = new Date("2025-01-01T00:00:00Z");
const t1 = new Date("2025-01-01T00:00:01Z");
const byName = (s: ReadableSpan[], n: string) => s.find((x) => x.name === n);

describe("IntrospectionMastraExporter — content-shape normalisation", () => {
  it("normalises array-content parts, role/parts, function_call_output, item_reference", async () => {
    const { exporter, mastra, feed } = makeExporter();

    await feed({
      type: "model_step",
      traceId: "shapes-1",
      name: "llm",
      startTime: t0,
      endTime: t1,
      input: [
        {
          role: "user",
          content: [
            { type: "text", text: "plain text" },
            { type: "input_text", text: "responses-api text" },
            { type: "image", url: "x" }, // unknown → JSON.stringify fallback
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolName: "lookup",
              toolCallId: "c1",
              args: { q: 1 },
            },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "c1", result: "done" }],
        },
        // role present but content null → falls back to `parts`
        { role: "user", parts: [{ type: "text", content: "from parts" }] },
        // OpenAI Responses API items (no role)
        { type: "function_call_output", call_id: "c2", output: "fn out" },
        { type: "item_reference", id: "ref1" }, // skipped
      ],
      attributes: {},
    });
    await feed({
      type: "agent_run",
      traceId: "shapes-1",
      name: "agent",
      startTime: t0,
      endTime: t1,
      // system instructions via ARRAY content → _extractTextContent array path
      input: [
        { role: "system", content: [{ type: "text", text: "sys line" }] },
      ],
    });

    const llm = byName(exporter.getFinishedSpans(), "llm")!;
    const input = String(llm.attributes["gen_ai.input.messages"]);
    expect(input).toContain("plain text");
    expect(input).toContain("responses-api text");
    expect(input).toContain("lookup"); // tool-call normalised
    expect(input).toContain("done"); // tool-result normalised
    expect(input).toContain("from parts"); // role+parts path
    expect(input).toContain("fn out"); // function_call_output
    expect(input).not.toContain("ref1"); // item_reference skipped

    const root = byName(exporter.getFinishedSpans(), "trace")!;
    expect(String(root.attributes["gen_ai.system_instructions"])).toContain(
      "sys line",
    );
    await mastra.shutdown();
  });

  it("normalises output field-name variants (reasoning.content, toolCalls name/id/input)", async () => {
    const { exporter, mastra, feed } = makeExporter();
    await feed({
      type: "model_step",
      traceId: "shapes-2",
      name: "llm",
      startTime: t0,
      endTime: t1,
      output: {
        reasoning: [{ content: "thought" }], // .content variant (not .text)
        toolCalls: [{ name: "n", id: "i", input: { a: 1 } }], // name/id/input variants
      },
      attributes: {},
    });
    await feed({
      type: "agent_run",
      traceId: "shapes-2",
      name: "a",
      startTime: t0,
      endTime: t1,
    });
    const out = String(
      byName(exporter.getFinishedSpans(), "llm")!.attributes[
        "gen_ai.output.messages"
      ],
    );
    expect(out).toContain("thought");
    expect(out).toContain('"n"'); // tool call name
    await mastra.shutdown();
  });

  it("handles a minimal model_step with every optional field absent", async () => {
    const { exporter, mastra, feed } = makeExporter();
    // No metadata/model, no input, no output, no usage, no finishReason.
    await feed({
      type: "model_step",
      traceId: "shapes-3",
      name: "bare-llm",
      startTime: t0,
      endTime: t1,
    });
    // agent_run with no input, no instructions, no metadata → generated conv id.
    await feed({
      type: "agent_run",
      traceId: "shapes-3",
      name: "bare-agent",
      startTime: t0,
      endTime: t1,
    });
    const spans = exporter.getFinishedSpans();
    const llm = byName(spans, "bare-llm")!; // name falls back to span.name (no model)
    expect(llm.attributes["gen_ai.request.model"]).toBeUndefined();
    expect(llm.attributes["gen_ai.input.messages"]).toBeUndefined();
    const root = byName(spans, "trace")!;
    // conversation id was generated (no metadata/attrs source)
    expect(String(root.attributes["gen_ai.conversation.id"])).toMatch(
      /^intro_conv_/,
    );
    await mastra.shutdown();
  });
});
