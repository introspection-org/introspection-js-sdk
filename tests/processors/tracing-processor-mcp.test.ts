/**
 * Integration test for Responses API MCP tools via DeepWiki.
 *
 * Records actual OpenAI API responses to validate that the tracing processor
 * correctly handles MCP tool calls from DeepWiki.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Polly } from "@pollyjs/core";
import {
  Agent,
  run,
  addTraceProcessor,
  setTraceProcessors,
  setTracingDisabled,
} from "@openai/agents";

import {
  createCaptureTracingProcessor,
  type CaptureTracingProcessor,
} from "../fixtures";
import {
  simplifySpansForSnapshot,
  sortSpansBySpanId,
  parseJsonAttr,
} from "../testing";
import { setupPolly, ensureEnvVarsForReplay } from "../polly-setup";

describe("Responses API - MCP DeepWiki", () => {
  let capture: CaptureTracingProcessor | null = null;
  let polly: Polly | null = null;

  beforeEach(() => {
    polly = setupPolly({
      recordingName: "responses-api-mcp",
      adapters: ["fetch"],
    });

    if (!ensureEnvVarsForReplay(["OPENAI_API_KEY"], "responses-api-mcp")) {
      console.log(
        "Skipping: Required env vars not set for record/passthrough mode",
      );
      polly.stop();
      polly = null;
      return;
    }

    setTracingDisabled(false);
    capture = createCaptureTracingProcessor();
    addTraceProcessor(capture.processor);
  });

  afterEach(async () => {
    if (capture) {
      setTraceProcessors([]);
      await capture.processor.shutdown();
      capture = null;
    }
    if (polly) {
      await polly.stop();
      polly = null;
    }
  });

  it("should capture MCP tool calls via DeepWiki with correct gen_ai attributes", async () => {
    if (!capture) return;

    const agent = new Agent({
      name: "MCP DeepWiki Agent",
      model: "gpt-4o",
      instructions:
        "Use the DeepWiki MCP tools to answer questions about code repositories. Be very concise.",
      modelSettings: {
        providerData: {
          tools: [
            {
              type: "mcp",
              server_label: "deepwiki",
              server_url: "https://mcp.deepwiki.com/mcp",
              require_approval: "never",
            },
          ],
        },
      },
    });

    const result = await run(
      agent,
      "What programming language is the openai/openai-agents-python repo written in? One word answer.",
    );
    expect(result.finalOutput).toBeDefined();

    await capture.processor.forceFlush();
    const spans = capture.exporter.getFinishedSpans();
    const sortedSpans = sortSpansBySpanId(spans);

    expect(sortedSpans.length).toBeGreaterThanOrEqual(2);

    const simplified = simplifySpansForSnapshot(sortedSpans, {
      normalize: true,
    });

    // Agent span — shows agent configuration
    const agentSpan = simplified.find((s) => s.name === "MCP DeepWiki Agent");
    expect(agentSpan).toBeDefined();
    expect(agentSpan).toMatchInlineSnapshot(
      {
        trace_id: expect.any(String),
        span_id: expect.any(String),
      },
      `
        {
          "attributes": {
            "gen_ai.agent.handoffs": "[]",
            "gen_ai.agent.name": "MCP DeepWiki Agent",
            "gen_ai.agent.output_type": "text",
            "gen_ai.conversation.id": "<conversation_id>",
            "gen_ai.system": "openai",
            "gen_ai.tool.definitions": "[]",
            "openai_agents.span_data": "<span_data>",
            "openinference.span.kind": "AGENT",
          },
          "name": "MCP DeepWiki Agent",
          "span_id": Any<String>,
          "trace_id": Any<String>,
        }
      `,
    );

    // Response span — has gen_ai attributes with MCP output
    const responseSpans = simplified.filter((s) => s.name === "response");
    expect(responseSpans.length).toBeGreaterThanOrEqual(1);
    expect(responseSpans[0]).toMatchInlineSnapshot(
      {
        trace_id: expect.any(String),
        span_id: expect.any(String),
      },
      `
        {
          "attributes": {
            "gen_ai.conversation.id": "<conversation_id>",
            "gen_ai.input.messages": "[{"role":"user","parts":[{"type":"text","content":"What programming language is the openai/openai-agents-python repo written in? One word answer."}]}]",
            "gen_ai.operation.name": "chat",
            "gen_ai.output.messages": "<output_messages>",
            "gen_ai.request.model": "gpt-4o-2024-08-06",
            "gen_ai.response.id": "<response_id>",
            "gen_ai.system": "openai",
            "gen_ai.system_instructions": "[{"type":"text","content":"Use the DeepWiki MCP tools to answer questions about code repositories. Be very concise."}]",
            "gen_ai.tool.definitions": "[{"name":"mcp"}]",
            "gen_ai.usage.input_tokens": "<input_tokens>",
            "gen_ai.usage.output_tokens": "<output_tokens>",
            "openai_agents.span_data": "<span_data>",
            "openinference.span.kind": "LLM",
          },
          "name": "response",
          "span_id": Any<String>,
          "trace_id": Any<String>,
        }
      `,
    );

    // Validate MCP tool calls in raw (non-normalized) output messages
    const rawResponseSpans = sortedSpans.filter((s) => s.name === "response");
    let foundMcpToolCall = false;
    let foundMcpToolResponse = false;

    for (const rs of rawResponseSpans) {
      const outputRaw = rs.attributes["gen_ai.output.messages"];
      if (!outputRaw) continue;
      const outputMessages = parseJsonAttr(outputRaw) as Array<{
        role: string;
        parts: Array<{ type: string; name?: string }>;
      }>;
      for (const msg of outputMessages) {
        for (const part of msg.parts || []) {
          if (
            part.type === "tool_call" &&
            (part.name || "").includes("deepwiki/")
          ) {
            foundMcpToolCall = true;
          }
          if (part.type === "tool_call_response") {
            foundMcpToolResponse = true;
          }
        }
      }
    }

    expect(foundMcpToolCall).toBe(true);
    expect(foundMcpToolResponse).toBe(true);
  }, 120_000); // MCP calls via DeepWiki may take longer
});
