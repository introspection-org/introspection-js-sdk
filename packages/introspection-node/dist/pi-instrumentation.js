/**
 * First-party Pi Agent SDK instrumentation for Introspection.
 *
 * Provides two functions that wrap a Pi agent session to produce OTel
 * GenAI spans for model calls and tool executions:
 *
 *   instrumentPiModelCalls(agent, tracer, meta, getParentContext)
 *   instrumentPiToolExecutions(session, tracer, meta, getParentContext)
 *
 * Uses structural typing — no @mariozechner/* imports required.
 *
 * @example
 * ```typescript
 * import { instrumentPiModelCalls, instrumentPiToolExecutions } from "@introspection-sdk/introspection-node/pi";
 *
 * const unsubModel = instrumentPiModelCalls(session.agent, tracer, meta, () => turnContext);
 * const unsubTool = instrumentPiToolExecutions(session, tracer, meta, () => turnContext);
 * ```
 */
import { context as otelContext, SpanKind, SpanStatusCode, } from "@opentelemetry/api";
import { piAssistantToSemconv, piMessagesToSemconv, piSystemPromptToSemconv, } from "./converters/pi-agent.js";
export { piMessagesToSemconv, piAssistantToSemconv, piSystemPromptToSemconv, semconvToPiMessages, } from "./converters/pi-agent.js";
// ─────────────────────────────────────────────────────────────────────────────
// Span attribute helpers
// ─────────────────────────────────────────────────────────────────────────────
const MAX_SYSTEM_INSTRUCTIONS_BYTES = 64_000;
const MAX_TOOL_DEFINITIONS_BYTES = 64_000;
function serializeSystemInstructions(systemPrompt) {
    if (!systemPrompt)
        return undefined;
    const serialized = piSystemPromptToSemconv(systemPrompt);
    if (Buffer.byteLength(serialized) <= MAX_SYSTEM_INSTRUCTIONS_BYTES) {
        return serialized;
    }
    return undefined;
}
function serializeToolDefinitions(tools) {
    if (tools.length === 0)
        return undefined;
    const detailed = JSON.stringify(tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
    })));
    if (Buffer.byteLength(detailed) <= MAX_TOOL_DEFINITIONS_BYTES) {
        return detailed;
    }
    const compact = JSON.stringify(tools.map((tool) => ({ type: "function", name: tool.name })));
    if (Buffer.byteLength(compact) <= MAX_TOOL_DEFINITIONS_BYTES) {
        return compact;
    }
    return undefined;
}
function serializeValue(value) {
    return typeof value === "string" ? value : JSON.stringify(value);
}
// ─────────────────────────────────────────────────────────────────────────────
// Model call instrumentation
// ─────────────────────────────────────────────────────────────────────────────
function setUsageAttributes(span, message) {
    span.setAttribute("gen_ai.usage.input_tokens", message.usage.input);
    span.setAttribute("gen_ai.usage.output_tokens", message.usage.output);
    if (message.usage.cacheRead > 0) {
        span.setAttribute("gen_ai.usage.cache_read.input_tokens", message.usage.cacheRead);
    }
    if (message.usage.cacheWrite > 0) {
        span.setAttribute("gen_ai.usage.cache_creation.input_tokens", message.usage.cacheWrite);
    }
}
function setToolDefinitionsOnSpan(span, tools) {
    if (!tools?.length)
        return;
    const serialized = serializeToolDefinitions(tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
    })));
    if (serialized) {
        span.setAttribute("gen_ai.tool.definitions", serialized);
    }
}
function getResponseId(event) {
    const message = event.type === "done" ? event.message : event.error;
    if (!message)
        return undefined;
    return message.responseId || message.id || event.messageId;
}
function finishModelSpan(span, event, flushFn) {
    const message = event.type === "done" ? event.message : event.error;
    if (!message) {
        span.end();
        flushFn?.();
        return;
    }
    span.setAttribute("gen_ai.output.messages", piAssistantToSemconv(message));
    const responseId = getResponseId(event);
    if (responseId) {
        span.setAttribute("gen_ai.response.id", responseId);
    }
    span.setAttribute("gen_ai.response.finish_reasons", JSON.stringify([message.stopReason]));
    setUsageAttributes(span, message);
    if (event.type === "error" || message.stopReason === "error") {
        const errorMessage = message.errorMessage || "Unknown error";
        span.setAttribute("error.type", "model_finish_reason_error");
        span.setAttribute("error.message", errorMessage);
        span.setStatus({ code: SpanStatusCode.ERROR, message: errorMessage });
    }
    else {
        span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end();
    flushFn?.();
}
/**
 * Instrument a Pi agent's model calls with OTel GenAI spans.
 *
 * Wraps `agent.streamFn` to intercept every LLM call, creating a span
 * with input/output messages, token usage, tool definitions, and system
 * instructions.
 *
 * @returns A function that restores the original `streamFn`.
 */
export function instrumentPiModelCalls(agent, tracer, meta, getParentContext, flushFn) {
    const originalStreamFn = agent.streamFn;
    agent.streamFn = ((model, context, options) => {
        const parentContext = getParentContext?.() ?? otelContext.active();
        const inputMessages = piMessagesToSemconv(context.messages);
        const span = tracer.startSpan(`gen_ai.call ${model.provider}`, { kind: SpanKind.INTERNAL }, parentContext);
        span.setAttributes({
            "gen_ai.conversation.id": meta.conversationId,
            "gen_ai.agent.id": meta.agentId,
            "gen_ai.agent.name": meta.agentName,
            "gen_ai.operation.name": "chat",
            "gen_ai.provider.name": model.provider,
            "gen_ai.request.model": model.id,
        });
        const systemInstructions = serializeSystemInstructions(context.systemPrompt);
        if (systemInstructions) {
            span.setAttribute("gen_ai.system_instructions", systemInstructions);
        }
        setToolDefinitionsOnSpan(span, context.tools);
        span.setAttribute("gen_ai.input.messages", inputMessages);
        // Wrap the underlying stream to intercept done/error events.
        const underlying = originalStreamFn(model, context, options);
        // Handle both sync and async streamFn return
        const wrapStream = (stream) => {
            const original = stream[Symbol.asyncIterator].bind(stream);
            // Replace the async iterator to intercept events
            const intercepted = (async function* () {
                try {
                    for await (const event of { [Symbol.asyncIterator]: original }) {
                        yield event;
                        if (event.type === "done" || event.type === "error") {
                            finishModelSpan(span, event, flushFn);
                        }
                    }
                }
                catch (err) {
                    span.setStatus({
                        code: SpanStatusCode.ERROR,
                        message: err instanceof Error ? err.message : String(err),
                    });
                    span.end();
                    flushFn?.();
                    throw err;
                }
            })();
            return {
                push: stream.push.bind(stream),
                end: stream.end.bind(stream),
                [Symbol.asyncIterator]: () => intercepted[Symbol.asyncIterator](),
            };
        };
        if (underlying instanceof Promise) {
            return underlying.then(wrapStream);
        }
        return wrapStream(underlying);
    });
    return () => {
        agent.streamFn = originalStreamFn;
    };
}
// ─────────────────────────────────────────────────────────────────────────────
// Tool execution instrumentation
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Instrument a Pi session's tool executions with OTel spans.
 *
 * Subscribes to `tool_execution_start` and `tool_execution_end` events,
 * creating a span for each tool invocation with arguments and results.
 *
 * @returns A function that unsubscribes and ends any active tool spans.
 */
export function instrumentPiToolExecutions(session, tracer, meta, getParentContext, flushFn) {
    const commonAttrs = {
        "gen_ai.conversation.id": meta.conversationId,
        "gen_ai.agent.id": meta.agentId,
        "gen_ai.agent.name": meta.agentName,
    };
    const activeToolSpans = new Map();
    const unsubscribe = session.subscribe((event) => {
        switch (event.type) {
            case "tool_execution_start": {
                const { toolCallId, toolName, args } = event;
                if (!toolCallId || !toolName)
                    return;
                const parentContext = getParentContext?.() ?? otelContext.active();
                const span = tracer.startSpan(toolName, { kind: SpanKind.INTERNAL }, parentContext);
                span.setAttributes({
                    ...commonAttrs,
                    "gen_ai.operation.name": "execute_tool",
                    "gen_ai.tool.name": toolName,
                    "gen_ai.tool.call.id": toolCallId,
                });
                if (args !== undefined) {
                    span.setAttribute("gen_ai.tool.call.arguments", serializeValue(args));
                }
                activeToolSpans.set(toolCallId, span);
                break;
            }
            case "tool_execution_end": {
                const { toolCallId, result, isError } = event;
                if (!toolCallId)
                    return;
                const span = activeToolSpans.get(toolCallId);
                if (!span)
                    return;
                if (result !== undefined) {
                    span.setAttribute("gen_ai.tool.call.result", serializeValue(result));
                }
                span.setStatus({
                    code: isError ? SpanStatusCode.ERROR : SpanStatusCode.OK,
                    message: isError && result !== undefined
                        ? serializeValue(result)
                        : undefined,
                });
                span.end();
                activeToolSpans.delete(toolCallId);
                flushFn?.();
                break;
            }
        }
    });
    return () => {
        unsubscribe();
        for (const span of activeToolSpans.values()) {
            span.end();
        }
        activeToolSpans.clear();
        flushFn?.();
    };
}
