/**
 * OpenClaw event handlers — translate the plugin's lifecycle hooks into
 * OTel GenAI semantic-convention spans.
 *
 *   before_agent_start  → invoke_agent {agent.name}    (session root span)
 *     ├─ llm_input/output → chat {provider}            (per LLM call)
 *     │                  └─ (when tools used: a second `chat {provider}`
 *     │                       span carrying the final assistant response)
 *     └─ before_tool_call / tool_result_persist → execute_tool {tool}
 *
 * Span and attribute construction lives in `./attributes`; conversion
 * between OpenClaw payloads and semconv message JSON lives in `./util`.
 * This module only owns the span lifecycle.
 */

import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import {
  GenAiSpanName,
  type InputMessage,
  type OutputMessage,
} from "@introspection-sdk/types";
import { randomUUID } from "node:crypto";
import {
  agentEndAttributes,
  chatRequestAttributes,
  chatResponseAttributes,
  executeToolAttributes,
  executeToolResultAttributes,
  invokeAgentAttributes,
  toolResponseChatAttributes,
  type AgentMeta,
  type UsageDelta,
} from "./attributes.js";
import { getTracer } from "./otel.js";
import { spanStore, type ToolCallRecord } from "./span-store.js";
import {
  convertInputMessages,
  convertOutputMessages,
  prepareForCapture,
  safeJsonStringify,
} from "./util.js";

// ─── types ─────────────────────────────────────────────────────────────────

export interface CaptureConfig {
  captureMessageContent: boolean;
  captureToolInput: boolean;
  captureToolOutput: boolean;
  maxCaptureLength: number;
}

type AnyEvent = Record<string, unknown>;

// ─── small helpers ─────────────────────────────────────────────────────────

function sessionKeyFrom(ctx: AnyEvent): string | undefined {
  const key = ctx.sessionKey ?? ctx.sessionId;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Extract a list of `{name, description}` tool definitions from OpenClaw's
 * system prompt — bullet lines under a `Tool availability` header.
 *
 *   ## Tool availability
 *   - read: Read file contents
 *   - write: Write to a file
 */
function parseToolsFromSystemPrompt(
  prompt: string,
): Array<{ name: string; description: string }> {
  const sectionStart = prompt.indexOf("Tool availability");
  if (sectionStart === -1) return [];
  const sectionEnd = prompt.indexOf("\n##", sectionStart + 20);
  const section =
    sectionEnd > 0
      ? prompt.slice(sectionStart, sectionEnd)
      : prompt.slice(sectionStart, sectionStart + 2000);

  const result: Array<{ name: string; description: string }> = [];
  const re = /^- (\w+): (.+)$/gm;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic exec loop
  while ((match = re.exec(section)) !== null) {
    result.push({ name: match[1]!, description: match[2]! });
  }
  return result;
}

/** Read tool definitions from the event; fall back to parsing the system prompt. */
function toolDefsFromEvent(
  event: AnyEvent,
): Array<{ name: string; description?: string }> | undefined {
  if (Array.isArray(event.tools) && event.tools.length > 0) {
    return event.tools as Array<{ name: string; description?: string }>;
  }
  if (typeof event.systemPrompt === "string") {
    const parsed = parseToolsFromSystemPrompt(event.systemPrompt);
    if (parsed.length > 0) return parsed;
  }
  return undefined;
}

function readUsage(event: AnyEvent): UsageDelta | undefined {
  const usage = event.usage as AnyEvent | undefined;
  if (!usage) return undefined;
  const out: UsageDelta = {};
  if (isFiniteNumber(usage.input)) out.input = usage.input;
  if (isFiniteNumber(usage.output)) out.output = usage.output;
  if (isFiniteNumber(usage.cacheRead)) out.cacheRead = usage.cacheRead;
  if (isFiniteNumber(usage.cacheWrite)) out.cacheWrite = usage.cacheWrite;
  return out;
}

function readCostUsd(lastAssistant: unknown): number | undefined {
  if (typeof lastAssistant !== "object" || lastAssistant === null)
    return undefined;
  const usage = (lastAssistant as AnyEvent).usage as AnyEvent | undefined;
  const cost = usage?.cost as AnyEvent | undefined;
  return cost && isFiniteNumber(cost.total) ? cost.total : undefined;
}

function readFinishReason(lastAssistant: unknown): string | undefined {
  if (typeof lastAssistant !== "object" || lastAssistant === null)
    return undefined;
  const stop = (lastAssistant as AnyEvent).stopReason;
  return typeof stop === "string" ? stop : undefined;
}

// ─── before_agent_start ────────────────────────────────────────────────────

export function handleBeforeAgentStart(_event: AnyEvent, ctx: AnyEvent): void {
  const sessionKey = sessionKeyFrom(ctx);
  if (!sessionKey) return;

  const agentName = (ctx.agentId as string) || "agent";
  const meta: AgentMeta = {
    agentId: agentName,
    agentName,
    conversationId: randomUUID(),
  };

  const tracer = getTracer();
  const agentSpan = tracer.startSpan(
    GenAiSpanName.invokeAgent(agentName),
    {
      kind: SpanKind.INTERNAL,
      attributes: invokeAgentAttributes(meta, sessionKey),
    },
    context.active(),
  );

  spanStore.set(sessionKey, {
    agentSpan,
    agentCtx: trace.setSpan(context.active(), agentSpan),
    toolStack: [],
    llmSpans: new Map(),
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    toolSequence: 0,
    toolCalls: [],
    startTime: Date.now(),
  });
}

// ─── llm_input ─────────────────────────────────────────────────────────────

export function handleLlmInput(
  event: AnyEvent,
  ctx: AnyEvent,
  capture: CaptureConfig,
): void {
  const sessionKey = sessionKeyFrom(ctx);
  if (!sessionKey) return;
  const session = spanStore.get(sessionKey);
  if (!session) return;

  const provider = (event.provider as string) || "unknown";
  const model = (event.model as string) || "unknown";
  const runId = event.runId as string;
  const agentName = (ctx.agentId as string) || "agent";

  // Stash for agent_end finalisation.
  session.model = event.model as string | undefined;
  session.provider = event.provider as string | undefined;
  if (event.provider) {
    session.agentSpan.setAttribute("gen_ai.provider.name", provider);
  }

  const inputMessages = capture.captureMessageContent
    ? convertInputMessages(
        Array.isArray(event.historyMessages) ? event.historyMessages : [],
        event.prompt,
      )
    : undefined;

  const attrs = chatRequestAttributes({
    agentName,
    provider,
    model,
    runId,
    imagesCount: isFiniteNumber(event.imagesCount)
      ? event.imagesCount
      : undefined,
    systemPrompt: capture.captureMessageContent
      ? typeof event.systemPrompt === "string"
        ? event.systemPrompt
        : event.systemPrompt
          ? safeJsonStringify(event.systemPrompt)
          : undefined
      : undefined,
    toolDefinitions: toolDefsFromEvent(event),
    inputMessages,
  });

  const tracer = getTracer();
  const span = tracer.startSpan(
    GenAiSpanName.chat(provider),
    { kind: SpanKind.INTERNAL, attributes: attrs },
    session.agentCtx,
  );

  spanStore.setLlmSpan(sessionKey, runId, {
    span,
    ctx: trace.setSpan(session.agentCtx, span),
    runId,
    provider,
    model,
    startTime: Date.now(),
  });
}

// ─── llm_output ────────────────────────────────────────────────────────────

export function handleLlmOutput(
  event: AnyEvent,
  ctx: AnyEvent,
  capture: CaptureConfig,
): void {
  const sessionKey = sessionKeyFrom(ctx);
  if (!sessionKey) return;
  const session = spanStore.get(sessionKey);
  if (!session) return;

  // Track latest model/provider so agent_end can finalise the parent span.
  session.model = (event.model as string) ?? session.model;
  session.provider = (event.provider as string) ?? session.provider;

  const llmEntry = spanStore.deleteLlmSpan(sessionKey, event.runId as string);
  if (!llmEntry) return;

  const usage = readUsage(event);
  if (usage) {
    if (usage.input) session.tokens.input += usage.input;
    if (usage.output) session.tokens.output += usage.output;
    if (usage.cacheRead) session.tokens.cacheRead += usage.cacheRead;
    if (usage.cacheWrite) session.tokens.cacheWrite += usage.cacheWrite;
  }

  try {
    const responseModel = (event.model as string) || llmEntry.model;
    const finishReason = readFinishReason(event.lastAssistant);
    const costUsd = readCostUsd(event.lastAssistant);
    const outputMessages =
      capture.captureMessageContent && event.lastAssistant !== undefined
        ? convertOutputMessages(event.lastAssistant)
        : undefined;
    const hasToolCalls = session.toolCalls.length > 0;

    if (hasToolCalls && outputMessages) {
      // Tool-using turn: split into a tool-calling span + a separate
      // "final response" span keyed off the synthetic tool-result input.
      llmEntry.span.setAttributes(
        chatResponseAttributes({
          responseModel,
          usage,
          finishReason: "tool_calls",
          costUsd,
          outputMessages: assistantOutputMessage(session.toolCalls),
        }),
      );
      llmEntry.span.setStatus({ code: SpanStatusCode.OK });
      llmEntry.span.end();

      const tracer = getTracer();
      const responseSpan = tracer.startSpan(
        GenAiSpanName.chat(llmEntry.provider),
        {
          kind: SpanKind.INTERNAL,
          attributes: toolResponseChatAttributes({
            agentName: (ctx.agentId as string) || "agent",
            provider: llmEntry.provider,
            requestModel: llmEntry.model,
            responseModel,
            usage,
            finishReason,
            outputMessages,
            inputMessages: toolResultInput(session.toolCalls),
          }),
        },
        session.agentCtx,
      );
      responseSpan.setStatus({ code: SpanStatusCode.OK });
      responseSpan.end();
      return;
    }

    // Simple turn: one span carrying request + response on one call.
    llmEntry.span.setAttributes(
      chatResponseAttributes({
        responseModel,
        usage,
        finishReason,
        costUsd,
        outputMessages,
      }),
    );
    llmEntry.span.setStatus({ code: SpanStatusCode.OK });
    llmEntry.span.end();
  } catch (err) {
    llmEntry.span.setStatus({
      code: SpanStatusCode.ERROR,
      message: String(err),
    });
    llmEntry.span.end();
  }
}

// ─── before_tool_call ──────────────────────────────────────────────────────

export function handleBeforeToolCall(
  event: AnyEvent,
  ctx: AnyEvent,
  capture: CaptureConfig,
): void {
  const sessionKey = sessionKeyFrom(ctx);
  if (!sessionKey) return;
  const session = spanStore.get(sessionKey);
  if (!session) return;

  const toolName =
    (typeof ctx.toolName === "string" && ctx.toolName) ||
    (typeof event.toolName === "string" && event.toolName) ||
    "unknown";

  session.toolSequence += 1;

  const tracer = getTracer();
  const span = tracer.startSpan(
    GenAiSpanName.executeTool(toolName),
    {
      kind: SpanKind.INTERNAL,
      attributes: executeToolAttributes({
        toolName,
        sequence: session.toolSequence,
        params: event.params,
        captureToolInput: capture.captureToolInput,
        maxCaptureLength: capture.maxCaptureLength,
      }),
    },
    session.agentCtx,
  );

  // Record for output-message reconstruction in handleLlmOutput.
  session.toolCalls.push({
    id: `tool_${session.toolSequence}`,
    name: toolName,
    arguments:
      event.params !== undefined ? safeJsonStringify(event.params) : undefined,
  });

  spanStore.pushTool(sessionKey, {
    span,
    ctx: trace.setSpan(session.agentCtx, span),
    name: toolName,
    startTime: Date.now(),
  });
}

// ─── tool_result_persist ───────────────────────────────────────────────────

export function handleToolResultPersist(
  event: AnyEvent,
  ctx: AnyEvent,
  capture: CaptureConfig,
): void {
  const sessionKey = sessionKeyFrom(ctx);
  if (!sessionKey) return;
  const entry = spanStore.popTool(sessionKey);
  if (!entry) return;

  try {
    entry.span.setAttributes(
      executeToolResultAttributes({
        durationMs: Date.now() - entry.startTime,
        message: event.message,
        captureToolOutput: capture.captureToolOutput,
        maxCaptureLength: capture.maxCaptureLength,
      }),
    );

    // Pair this result with the matching tool call (FIFO — emitter guarantees
    // tool_result_persist fires in the same order as before_tool_call).
    if (event.message !== undefined) {
      const session = spanStore.get(sessionKey);
      if (session) {
        const recorded = session.toolCalls.findIndex(
          (tc) => tc.result === undefined,
        );
        if (recorded >= 0) {
          session.toolCalls[recorded]!.result = prepareForCapture(
            event.message,
            capture.maxCaptureLength,
          );
        }
      }
    }

    entry.span.setStatus({ code: SpanStatusCode.OK });
  } finally {
    entry.span.end();
  }
}

// ─── agent_end ─────────────────────────────────────────────────────────────

/**
 * Finalize and close the agent span.
 *
 * OpenClaw can fire `agent_end` *before* the final `llm_output`, so we defer
 * the actual span close to the next tick — that gives `llm_output` a chance
 * to write token usage and output content first.
 */
export function handleAgentEnd(event: AnyEvent, ctx: AnyEvent): void {
  const sessionKey = sessionKeyFrom(ctx);
  if (!sessionKey) return;
  const session = spanStore.get(sessionKey);
  if (!session) return;

  const durationMs = isFiniteNumber(event.durationMs)
    ? event.durationMs
    : Date.now() - session.startTime;
  const failed = !!(event.error || event.success === false);
  const errorMsg = (event.error as string) || "Agent invocation failed";

  setTimeout(() => {
    // Safety net: close any tool / LLM spans that didn't get terminated cleanly.
    for (let i = session.toolStack.length - 1; i >= 0; i--) {
      session.toolStack[i]!.span.end();
    }
    for (const llm of [...session.llmSpans.values()].reverse()) {
      llm.span.end();
    }

    session.agentSpan.setAttributes(
      agentEndAttributes({
        durationMs,
        toolCount: session.toolSequence,
        tokens: session.tokens,
        model: session.model,
        provider: session.provider,
      }),
    );

    if (failed) {
      session.agentSpan.setAttribute("error.type", "AgentError");
      session.agentSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: errorMsg,
      });
    } else {
      session.agentSpan.setStatus({ code: SpanStatusCode.OK });
    }

    session.agentSpan.end();
    spanStore.delete(sessionKey);
  }, 0);
}

// ─── output-message helpers ────────────────────────────────────────────────

/** Build the `[{role:"assistant", parts:[{tool_call ...}]}]` shape. */
function assistantOutputMessage(toolCalls: ToolCallRecord[]): OutputMessage[] {
  return [
    {
      role: "assistant",
      finish_reason: "tool_calls",
      parts: toolCalls.map((tc) => ({
        type: "tool_call",
        id: tc.id,
        name: tc.name,
        arguments: tc.arguments,
      })),
    },
  ];
}

/** Build synthetic `tool` messages used as `gen_ai.input.messages` for the response span. */
function toolResultInput(toolCalls: ToolCallRecord[]): InputMessage[] {
  return toolCalls.map((tc) => ({
    role: "tool",
    name: tc.name,
    parts: [
      {
        type: "tool_call_response",
        id: tc.id,
        response: tc.result ?? "",
      },
    ],
  }));
}
