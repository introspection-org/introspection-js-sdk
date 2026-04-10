import { context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { trace } from "@opentelemetry/api";
import { randomUUID } from "node:crypto";
import { getTracer } from "./otel.js";
import { spanStore } from "./span-store.js";
import {
  prepareForCapture,
  safeJsonStringify,
  convertInputMessages,
  convertOutputMessages,
} from "./util.js";

// ---------- types ----------

export interface CaptureConfig {
  captureMessageContent: boolean;
  captureToolInput: boolean;
  captureToolOutput: boolean;
  maxCaptureLength: number;
}

// ---------- helpers ----------

function sessionKeyFrom(ctx: Record<string, unknown>): string | undefined {
  const key = ctx.sessionKey ?? ctx.sessionId;
  return typeof key === "string" && key.length > 0 ? key : undefined;
}

/** Generate a unique conversation ID per agent turn (UUID v4). */
function newConversationId(): string {
  return randomUUID();
}

/** Parse tool names from OpenClaw's system prompt "Tool availability" section.
 *  Lines like "- read: Read file contents" → [{type:"function", function:{name,description}}] */
function parseToolsFromSystemPrompt(
  prompt: string,
): Array<{ name: string; description: string }> {
  const result: Array<{ name: string; description: string }> = [];
  // Match lines like "- toolName: description" in the tool availability block
  const toolLineRe = /^- (\w+): (.+)$/gm;
  let match: RegExpExecArray | null;
  // Only parse within the "Tool availability" section
  const sectionStart = prompt.indexOf("Tool availability");
  if (sectionStart === -1) return result;
  const sectionEnd = prompt.indexOf("\n##", sectionStart + 20);
  const section =
    sectionEnd > 0
      ? prompt.slice(sectionStart, sectionEnd)
      : prompt.slice(sectionStart, sectionStart + 2000);

  while ((match = toolLineRe.exec(section)) !== null) {
    result.push({ name: match[1]!, description: match[2]! });
  }
  return result;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

// ---------- before_agent_start ----------

export function handleBeforeAgentStart(
  _event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): void {
  const sessionKey = sessionKeyFrom(ctx);
  if (!sessionKey) return;

  const tracer = getTracer();
  const agentName = (ctx.agentId as string) || "agent";
  const spanName = `invoke_agent ${agentName}`;

  const agentSpan = tracer.startSpan(
    spanName,
    {
      kind: SpanKind.INTERNAL,
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        "gen_ai.agent.name": agentName,
        "gen_ai.agent.id": agentName,
        "gen_ai.conversation.id": newConversationId(),
        "openclaw.session_key": sessionKey,
      },
    },
    context.active(),
  );

  const agentCtx = trace.setSpan(context.active(), agentSpan);

  spanStore.set(sessionKey, {
    agentSpan,
    agentCtx,
    toolStack: [],
    llmSpans: new Map(),
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    toolSequence: 0,
    toolCalls: [],
    startTime: Date.now(),
  });
}

// ---------- llm_input ----------

export function handleLlmInput(
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
  capture: CaptureConfig,
): void {
  const sessionKey = sessionKeyFrom(ctx);
  if (!sessionKey) return;

  const session = spanStore.get(sessionKey);
  if (!session) return;

  // Store model/provider for agent_end
  session.model = event.model as string | undefined;
  session.provider = event.provider as string | undefined;

  // Update provider on agent span if it was unknown at start
  if (event.provider) {
    session.agentSpan.setAttribute(
      "gen_ai.provider.name",
      event.provider as string,
    );
  }

  const tracer = getTracer();
  const provider = (event.provider as string) || "unknown";
  const model = (event.model as string) || "unknown";
  const runId = event.runId as string;

  const attributes: Record<string, string | number> = {
    "gen_ai.operation.name": "chat",
    "gen_ai.agent.name": (ctx.agentId as string) || "agent",
    "gen_ai.request.model": model,
    "gen_ai.provider.name": provider,
    "openclaw.llm.run_id": runId,
  };

  if (isFiniteNumber(event.imagesCount)) {
    attributes["openclaw.llm.images_count"] = event.imagesCount;
  }

  // gen_ai.tool.definitions — available tools from OpenClaw.
  // Try event.tools first; fall back to parsing the system prompt's
  // "Tool availability" section which lists tool names like "- toolName: desc"
  const tools = event.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    attributes["gen_ai.tool.definitions"] = safeJsonStringify(tools);
  } else if (typeof event.systemPrompt === "string") {
    const toolDefs = parseToolsFromSystemPrompt(event.systemPrompt);
    if (toolDefs.length > 0) {
      attributes["gen_ai.tool.definitions"] = safeJsonStringify(toolDefs);
    }
  }

  // Capture prompt content
  if (capture.captureMessageContent) {
    // gen_ai.system_instructions — system prompt in OTEL parts format
    if (event.systemPrompt) {
      const sysStr =
        typeof event.systemPrompt === "string"
          ? event.systemPrompt
          : safeJsonStringify(event.systemPrompt);
      attributes["gen_ai.system_instructions"] = safeJsonStringify([
        { type: "text", content: sysStr },
      ]);
      // Also set gen_ai.system as the raw provider name (per semconv)
      attributes["gen_ai.system"] = provider;
    }

    // gen_ai.input.messages — history + current prompt in OTEL semconv format
    const history = Array.isArray(event.historyMessages)
      ? event.historyMessages
      : [];
    const inputMessages = convertInputMessages(history, event.prompt);
    if (inputMessages.length > 0) {
      attributes["gen_ai.input.messages"] = safeJsonStringify(inputMessages);

      // The current user prompt is the last element appended by
      // convertInputMessages; everything before it is prior history.
      const currentPromptIdx = inputMessages.length - 1;
      attributes["introspection.new_messages.start"] =
        currentPromptIdx >= 0 ? currentPromptIdx : 0;
      attributes["introspection.new_messages.end"] = inputMessages.length;
    }
  }

  const span = tracer.startSpan(
    `gen_ai.chat ${provider}`,
    { kind: SpanKind.INTERNAL, attributes },
    session.agentCtx,
  );

  const spanCtx = trace.setSpan(session.agentCtx, span);

  spanStore.setLlmSpan(sessionKey, runId, {
    span,
    ctx: spanCtx,
    runId,
    provider,
    model,
    startTime: Date.now(),
  });
}

// ---------- llm_output ----------

export function handleLlmOutput(
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
  capture: CaptureConfig,
): void {
  const sessionKey = sessionKeyFrom(ctx);
  if (!sessionKey) return;

  const session = spanStore.get(sessionKey);
  if (!session) return;

  // Update model/provider (keep latest)
  session.model = (event.model as string) ?? session.model;
  session.provider = (event.provider as string) ?? session.provider;

  const llmEntry = spanStore.deleteLlmSpan(sessionKey, event.runId as string);
  const usage = event.usage as Record<string, unknown> | undefined;

  // Accumulate tokens on the session
  if (usage) {
    if (isFiniteNumber(usage.input)) session.tokens.input += usage.input;
    if (isFiniteNumber(usage.output)) session.tokens.output += usage.output;
    if (isFiniteNumber(usage.cacheRead))
      session.tokens.cacheRead += usage.cacheRead;
    if (isFiniteNumber(usage.cacheWrite))
      session.tokens.cacheWrite += usage.cacheWrite;
  }

  if (llmEntry) {
    try {
      if (usage) {
        if (usage.input !== undefined)
          llmEntry.span.setAttribute(
            "gen_ai.usage.input_tokens",
            usage.input as number,
          );
        if (usage.output !== undefined)
          llmEntry.span.setAttribute(
            "gen_ai.usage.output_tokens",
            usage.output as number,
          );
        if (usage.cacheRead !== undefined) {
          llmEntry.span.setAttribute(
            "openclaw.usage.cache_read_tokens",
            usage.cacheRead as number,
          );
          llmEntry.span.setAttribute(
            "gen_ai.usage.cache_read_input_tokens",
            usage.cacheRead as number,
          );
        }
        if (usage.cacheWrite !== undefined) {
          llmEntry.span.setAttribute(
            "openclaw.usage.cache_write_tokens",
            usage.cacheWrite as number,
          );
          llmEntry.span.setAttribute(
            "gen_ai.usage.cache_creation_input_tokens",
            usage.cacheWrite as number,
          );
        }
      }
      llmEntry.span.setAttribute(
        "gen_ai.response.model",
        (event.model as string) || llmEntry.model,
      );

      // gen_ai.response.finish_reasons
      const lastAssistant = event.lastAssistant as
        | Record<string, unknown>
        | undefined;
      if (lastAssistant && typeof lastAssistant === "object") {
        if (lastAssistant.stopReason) {
          llmEntry.span.setAttribute(
            "gen_ai.response.finish_reasons",
            safeJsonStringify([lastAssistant.stopReason]),
          );
        }
        // gen_ai.cost.usd from nested usage.cost.total
        const laUsage = lastAssistant.usage as
          | Record<string, unknown>
          | undefined;
        if (laUsage) {
          const cost = laUsage.cost as Record<string, unknown> | undefined;
          if (cost && isFiniteNumber(cost.total)) {
            llmEntry.span.setAttribute("gen_ai.cost.usd", cost.total);
          }
        }
      }

      // gen_ai.output.messages in OTEL semconv format
      if (capture.captureMessageContent && event.lastAssistant !== undefined) {
        const outputMessages = convertOutputMessages(event.lastAssistant);

        if (session.toolCalls.length > 0) {
          // --- Multi-span mode: split into tool-calling span + final response span ---

          // Span 1 (current llmEntry.span): the tool-calling step.
          // Output = assistant message with tool_call parts.
          const toolCallOutput = [
            {
              role: "assistant",
              parts: session.toolCalls.map((tc) => ({
                type: "tool_call",
                id: tc.id,
                name: tc.name,
                arguments: tc.arguments,
              })),
              finish_reason: "tool_calls",
            },
          ];
          llmEntry.span.setAttribute(
            "gen_ai.output.messages",
            safeJsonStringify(toolCallOutput),
          );
          llmEntry.span.setStatus({ code: SpanStatusCode.OK });
          llmEntry.span.end();

          // Span 2: the final response after tools completed.
          // Input = tool_call_response messages. Output = final text.
          const tracer = getTracer();
          const toolResultInput = session.toolCalls.map((tc) => ({
            role: "tool",
            parts: [
              {
                type: "tool_call_response",
                id: tc.id,
                response: tc.result || "",
              },
            ],
            name: tc.name,
          }));

          // Build attributes for the response span including token usage
          const responseAttrs: Record<string, string | number> = {
            "gen_ai.operation.name": "chat",
            "gen_ai.agent.name": (ctx.agentId as string) || "agent",
            "gen_ai.request.model": llmEntry.model,
            "gen_ai.response.model": (event.model as string) || llmEntry.model,
            "gen_ai.provider.name": llmEntry.provider,
            "gen_ai.input.messages": safeJsonStringify(toolResultInput),
            "gen_ai.output.messages": safeJsonStringify(outputMessages),
            "introspection.new_messages.start": 0,
            "introspection.new_messages.end": toolResultInput.length,
          };
          // Copy token usage so ContextUsage shows correct numbers
          if (usage) {
            if (usage.input !== undefined)
              responseAttrs["gen_ai.usage.input_tokens"] =
                usage.input as number;
            if (usage.output !== undefined)
              responseAttrs["gen_ai.usage.output_tokens"] =
                usage.output as number;
            if (usage.cacheRead !== undefined)
              responseAttrs["gen_ai.usage.cache_read_input_tokens"] =
                usage.cacheRead as number;
            if (usage.cacheWrite !== undefined)
              responseAttrs["gen_ai.usage.cache_creation_input_tokens"] =
                usage.cacheWrite as number;
          }
          const responseSpan = tracer.startSpan(
            `gen_ai.chat ${llmEntry.provider}`,
            { kind: SpanKind.INTERNAL, attributes: responseAttrs },
            session.agentCtx,
          );
          responseSpan.setStatus({ code: SpanStatusCode.OK });
          responseSpan.end();
        } else {
          // Simple case: no tool calls, just output the final text.
          llmEntry.span.setAttribute(
            "gen_ai.output.messages",
            safeJsonStringify(outputMessages),
          );
          llmEntry.span.setStatus({ code: SpanStatusCode.OK });
          llmEntry.span.end();
        }
      } else {
        llmEntry.span.setStatus({ code: SpanStatusCode.OK });
        llmEntry.span.end();
      }
    } catch (err) {
      if (llmEntry) {
        llmEntry.span.setStatus({
          code: SpanStatusCode.ERROR,
          message: String(err),
        });
        llmEntry.span.end();
      }
    }
  }
}

// ---------- before_tool_call ----------

export function handleBeforeToolCall(
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
  capture: CaptureConfig,
): void {
  const sessionKey = sessionKeyFrom(ctx);
  if (!sessionKey) return;

  const session = spanStore.get(sessionKey);
  if (!session) return;

  const tracer = getTracer();
  const toolName =
    (typeof ctx.toolName === "string" && ctx.toolName) ||
    (typeof event.toolName === "string" && event.toolName) ||
    "unknown";

  session.toolSequence++;

  const attributes: Record<string, string | number> = {
    "gen_ai.operation.name": "execute_tool",
    "gen_ai.tool.name": toolName,
    "gen_ai.tool.type": "function",
    "openclaw.tool.sequence": session.toolSequence,
  };

  // Capture tool arguments (gen_ai.tool.input per OTEL semconv)
  if (capture.captureToolInput && event.params !== undefined) {
    attributes["gen_ai.tool.input"] = prepareForCapture(
      event.params,
      capture.maxCaptureLength,
    );
    attributes["openclaw.tool.input_size"] = safeJsonStringify(
      event.params,
    ).length;
  }

  const span = tracer.startSpan(
    `execute_tool ${toolName}`,
    { kind: SpanKind.INTERNAL, attributes },
    session.agentCtx,
  );

  const toolCtx = trace.setSpan(session.agentCtx, span);

  // Record tool call for output message reconstruction.
  // Use a sequence-based ID; tool_result_persist will patch it with the
  // real toolCallId from Anthropic if available.
  const seqId = `tool_${session.toolSequence}`;
  session.toolCalls.push({
    id: seqId,
    name: toolName,
    arguments:
      event.params !== undefined ? safeJsonStringify(event.params) : undefined,
  });

  spanStore.pushTool(sessionKey, {
    span,
    ctx: toolCtx,
    name: toolName,
    startTime: Date.now(),
  });
}

// ---------- tool_result_persist ----------

export function handleToolResultPersist(
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
  capture: CaptureConfig,
): void {
  const sessionKey = sessionKeyFrom(ctx);
  if (!sessionKey) return;

  const entry = spanStore.popTool(sessionKey);
  if (!entry) return;

  try {
    const durationMs = Date.now() - entry.startTime;
    entry.span.setAttribute("openclaw.tool.duration_ms", durationMs);

    // Capture tool result
    if (event.message !== undefined) {
      const resultStr =
        typeof event.message === "string"
          ? event.message
          : safeJsonStringify(event.message);
      entry.span.setAttribute("openclaw.tool.output_size", resultStr.length);

      if (capture.captureToolOutput) {
        entry.span.setAttribute(
          "gen_ai.tool.output",
          prepareForCapture(event.message, capture.maxCaptureLength),
        );
      }

      // Record tool result directly on the ToolCallRecord.
      // tool_result_persist fires in the same order as before_tool_call,
      // so the Nth result maps to the Nth toolCall entry.
      const session2 = spanStore.get(sessionKey);
      if (session2) {
        // Count how many results we've already recorded
        const recordedCount = session2.toolCalls.filter(
          (tc) => tc.result !== undefined,
        ).length;
        const resultValue = prepareForCapture(
          event.message,
          capture.maxCaptureLength,
        );
        if (recordedCount < session2.toolCalls.length) {
          session2.toolCalls[recordedCount]!.result = resultValue;
        }
      }
    }

    entry.span.setStatus({ code: SpanStatusCode.OK });
  } finally {
    entry.span.end();
  }
}

// ---------- agent_end ----------

/**
 * Finalize and close the agent span.
 *
 * OpenClaw may fire `agent_end` BEFORE the final `llm_output`, so we
 * defer the actual span close to the next tick, giving `llm_output`
 * a chance to write token usage and output content first.
 */
export function handleAgentEnd(
  event: Record<string, unknown>,
  ctx: Record<string, unknown>,
): void {
  const sessionKey = sessionKeyFrom(ctx);
  if (!sessionKey) return;

  const session = spanStore.get(sessionKey);
  if (!session) return;

  // Capture event values now (before the event object is recycled)
  const durationMs = isFiniteNumber(event.durationMs)
    ? event.durationMs
    : Date.now() - session.startTime;
  const hasError = !!(event.error || event.success === false);
  const errorMsg = (event.error as string) || "Agent invocation failed";

  // Defer close to next tick so llm_output can fire first
  setTimeout(() => {
    // Close any remaining tool spans (safety net, LIFO)
    for (let i = session.toolStack.length - 1; i >= 0; i--) {
      session.toolStack[i]!.span.end();
    }

    // Close any pending LLM spans (aborted mid-call)
    for (const llm of [...session.llmSpans.values()].reverse()) {
      llm.span.end();
    }

    // Duration and tool count
    session.agentSpan.setAttribute("openclaw.request.duration_ms", durationMs);
    session.agentSpan.setAttribute(
      "openclaw.request.tool_count",
      session.toolSequence,
    );

    // Cumulative token usage (now includes llm_output data)
    const { tokens } = session;
    if (tokens.input > 0 || tokens.output > 0) {
      session.agentSpan.setAttribute("gen_ai.usage.input_tokens", tokens.input);
      session.agentSpan.setAttribute(
        "gen_ai.usage.output_tokens",
        tokens.output,
      );
      if (tokens.cacheRead > 0)
        session.agentSpan.setAttribute(
          "openclaw.usage.cache_read_tokens",
          tokens.cacheRead,
        );
      if (tokens.cacheWrite > 0)
        session.agentSpan.setAttribute(
          "openclaw.usage.cache_write_tokens",
          tokens.cacheWrite,
        );
    }

    // Model/provider from LLM hooks (last seen values)
    if (session.model) {
      session.agentSpan.setAttribute("gen_ai.request.model", session.model);
      session.agentSpan.setAttribute("gen_ai.response.model", session.model);
    }
    if (session.provider) {
      session.agentSpan.setAttribute("gen_ai.provider.name", session.provider);
    }

    // Error status
    if (hasError) {
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
