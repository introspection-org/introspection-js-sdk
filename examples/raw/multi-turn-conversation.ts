/**
 * Raw OTEL Multi-Turn Conversation Example
 *
 * Demonstrates how to manually construct GenAI semantic convention traces
 * using raw OpenTelemetry APIs — no framework SDK required.
 *
 * This creates a realistic multi-turn conversation with:
 * - Turn 1: user question → model tool call
 * - Tool span: tool execution with input/output
 * - Turn 2: conversation history (stacked messages) → final response
 * - Turn 3: simple follow-up to verify full history tracking
 *
 * Each chat span carries gen_ai.input.messages and gen_ai.output.messages
 * as span attributes (JSON-stringified arrays), matching the OTel GenAI
 * semantic conventions that Introspection materializes in ClickHouse.
 *
 * Messages use the **parts format** that matches our SDKs:
 *   { role, parts: [{ type, content/name/id/arguments/response }] }
 *
 * See: introspection-python-sdk/introspection_sdk/schemas/genai.py
 *      introspection-js-sdk/packages/introspection-node/src/types/genai.ts
 *
 * Uses SimpleSpanProcessor to export each span immediately on end(),
 * ensuring sequential ingestion for multi-turn conversations where
 * each turn must be processed before the next arrives.
 *
 * Run with: pnpm raw-conversation
 */

import {
  context as otelContext,
  SpanKind,
  SpanStatusCode,
  trace as otelTrace,
} from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";

const AGENT_NAME = "raw-otel-example";
const MODEL = "gpt-4o";
const SCOPE = "@introspection/examples";

// ── Message helpers (parts format) ──

function textMsg(role: string, content: string) {
  return { role, parts: [{ type: "text", content }] };
}

function toolCallMsg(
  calls: { id: string; name: string; arguments?: unknown }[],
) {
  return {
    role: "assistant",
    parts: calls.map((c) => ({
      type: "tool_call" as const,
      id: c.id,
      name: c.name,
      arguments: c.arguments,
    })),
    finish_reason: "tool_calls",
  };
}

function toolResponseMsg(id: string, result: unknown) {
  return {
    role: "tool",
    parts: [{ type: "tool_call_response", id, result }],
  };
}

async function main() {
  const token = process.env.INTROSPECTION_TOKEN;
  if (!token) throw new Error("INTROSPECTION_TOKEN is required");

  const baseUrl =
    process.env.INTROSPECTION_BASE_URL || "https://otel.introspection.dev";
  const endpoint = `${baseUrl.replace(/\/$/, "")}/v1/traces`;

  const provider = new BasicTracerProvider({
    resource: resourceFromAttributes({ [ATTR_SERVICE_NAME]: AGENT_NAME }),
    spanProcessors: [
      new SimpleSpanProcessor(
        new OTLPTraceExporter({
          url: endpoint,
          headers: { Authorization: `Bearer ${token}` },
        }),
      ),
    ],
  });

  const tracer = provider.getTracer(SCOPE, "0.1.0");
  const conversationId = `conv-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

  // Shared tool definitions and system instructions
  const toolDefinitions = [
    {
      name: "get_server_status",
      description:
        "Returns the current status, uptime, and version of the server.",
    },
  ];

  const systemInstructions = [
    {
      type: "text",
      content: "You are a helpful assistant with access to tools.",
    },
  ];

  const toolResult = { status: "healthy", uptime: "72h", version: "1.4.2" };

  // ── Turn 1: user asks a question, model decides to call a tool ──

  const turn1 = tracer.startSpan("chat", {
    kind: SpanKind.CLIENT,
    attributes: {
      "gen_ai.agent.name": AGENT_NAME,
      "gen_ai.conversation.id": conversationId,
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": MODEL,
      "gen_ai.request.temperature": 0.2,
      "gen_ai.request.max_tokens": 256,
      "gen_ai.response.id": `resp-${crypto.randomUUID()}`,
      "gen_ai.response.model": MODEL,
      "gen_ai.usage.input_tokens": 24,
      "gen_ai.usage.output_tokens": 18,
    },
  });

  const traceId = turn1.spanContext().traceId;
  const turn1Ctx = otelTrace.setSpan(otelContext.active(), turn1);

  // System instructions and tool definitions (set once, on first turn)
  turn1.setAttribute(
    "gen_ai.system_instructions",
    JSON.stringify(systemInstructions),
  );
  turn1.setAttribute(
    "gen_ai.tool.definitions",
    JSON.stringify(toolDefinitions),
  );

  // Input: user's question
  turn1.setAttribute(
    "gen_ai.input.messages",
    JSON.stringify([textMsg("user", "What is the current server status?")]),
  );

  // Output: model calls a tool instead of responding directly
  turn1.setAttribute(
    "gen_ai.output.messages",
    JSON.stringify([
      toolCallMsg([
        { id: "call_001", name: "get_server_status", arguments: {} },
      ]),
    ]),
  );

  // ── Tool span: execution of the tool call ──

  const toolSpan = tracer.startSpan(
    "get_server_status",
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "gen_ai.conversation.id": conversationId,
        "gen_ai.tool.name": "get_server_status",
        "gen_ai.tool.input": "{}",
        "gen_ai.tool.output": JSON.stringify(toolResult),
      },
    },
    turn1Ctx,
  );

  await new Promise((r) => setTimeout(r, 30)); // simulate tool latency
  toolSpan.setStatus({ code: SpanStatusCode.OK });
  toolSpan.end();

  turn1.setStatus({ code: SpanStatusCode.OK });
  turn1.end();

  // ── Turn 2: conversation continues with full message history ──

  const turn2 = tracer.startSpan("chat", {
    kind: SpanKind.CLIENT,
    attributes: {
      "gen_ai.agent.name": AGENT_NAME,
      "gen_ai.conversation.id": conversationId,
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": MODEL,
      "gen_ai.request.temperature": 0.2,
      "gen_ai.request.max_tokens": 256,
      "gen_ai.response.id": `resp-${crypto.randomUUID()}`,
      "gen_ai.response.model": MODEL,
      "gen_ai.usage.input_tokens": 48,
      "gen_ai.usage.output_tokens": 32,
    },
  });

  // Input: stacked conversation history — messages build on each other
  const turn2Input = [
    textMsg("user", "What is the current server status?"),
    toolCallMsg([{ id: "call_001", name: "get_server_status", arguments: {} }]),
    toolResponseMsg("call_001", JSON.stringify(toolResult)),
    textMsg("user", "Great, summarize the status in one sentence."),
  ];
  turn2.setAttribute("gen_ai.input.messages", JSON.stringify(turn2Input));

  // Output: final response incorporating the tool result
  const turn2Output = [
    {
      ...textMsg(
        "assistant",
        "The server is healthy, running version 1.4.2 with 72 hours of uptime.",
      ),
      finish_reason: "stop",
    },
  ];
  turn2.setAttribute("gen_ai.output.messages", JSON.stringify(turn2Output));

  // Child span: simulated inference latency
  const turn2Ctx = otelTrace.setSpan(otelContext.active(), turn2);
  const inference = tracer.startSpan(
    "inference",
    {
      kind: SpanKind.CLIENT,
      attributes: { "gen_ai.conversation.id": conversationId },
    },
    turn2Ctx,
  );
  await new Promise((r) => setTimeout(r, 50));
  inference.setStatus({ code: SpanStatusCode.OK });
  inference.end();

  turn2.setStatus({ code: SpanStatusCode.OK });
  turn2.end();

  // ── Turn 3: simple follow-up to verify history tracking ──

  const turn3 = tracer.startSpan("chat", {
    kind: SpanKind.CLIENT,
    attributes: {
      "gen_ai.agent.name": AGENT_NAME,
      "gen_ai.conversation.id": conversationId,
      "gen_ai.operation.name": "chat",
      "gen_ai.request.model": MODEL,
      "gen_ai.request.temperature": 0.2,
      "gen_ai.request.max_tokens": 256,
      "gen_ai.response.id": `resp-${crypto.randomUUID()}`,
      "gen_ai.response.model": MODEL,
      "gen_ai.usage.input_tokens": 96,
      "gen_ai.usage.output_tokens": 8,
    },
  });

  // Input: full history including turn 2's output + new user message
  turn3.setAttribute(
    "gen_ai.input.messages",
    JSON.stringify([
      ...turn2Input,
      turn2Output[0],
      textMsg("user", "Thank you!"),
    ]),
  );

  // Output: simple acknowledgement
  turn3.setAttribute(
    "gen_ai.output.messages",
    JSON.stringify([
      {
        ...textMsg(
          "assistant",
          "You're welcome! Let me know if you need anything else.",
        ),
        finish_reason: "stop",
      },
    ]),
  );

  await new Promise((r) => setTimeout(r, 30));
  turn3.setStatus({ code: SpanStatusCode.OK });
  turn3.end();

  // ── Shutdown (SimpleSpanProcessor exports immediately, no flush needed) ──

  await provider.shutdown();

  console.log("Trace sent successfully:");
  console.log(`  traceId:        ${traceId}`);
  console.log(`  conversationId: ${conversationId}`);
  console.log(`  spans:          5 (3 chat + 1 tool + 1 inference)`);
  console.log(`  total tokens:   168 in / 58 out`);
}

main().catch(console.error);
