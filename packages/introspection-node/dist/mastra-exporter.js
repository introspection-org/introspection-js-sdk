/**
 * Mastra-compatible Exporter for Introspection.
 *
 * Extends Mastra's BaseExporter to receive TracingEvents (Mastra's native
 * span format) and convert them to gen_ai.* OTel spans for the Introspection
 * backend.
 *
 * **Important:** This module requires `@mastra/observability` and `@mastra/core`
 * at runtime. Import via the subpath: `@introspection-sdk/introspection-node/mastra`
 *
 * @example
 * ```ts
 * import { Mastra } from "@mastra/core/mastra";
 * import { IntrospectionMastraExporter } from "@introspection-sdk/introspection-node/mastra";
 *
 * const mastra = new Mastra({
 *   agents: { myAgent },
 *   observability: {
 *     configs: {
 *       otel: {
 *         serviceName: "my-mastra-app",
 *         exporters: [new IntrospectionMastraExporter()],
 *       },
 *     },
 *   },
 * });
 * ```
 */
import { BaseExporter } from "@mastra/observability";
import { context as otelContext, trace as otelTrace, } from "@opentelemetry/api";
import { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { randomUUID } from "crypto";
import { logger } from "./utils.js";
import { VERSION } from "./version.js";
// ---------------------------------------------------------------------------
// Exporter
// ---------------------------------------------------------------------------
export class IntrospectionMastraExporter extends BaseExporter {
    name = "introspection";
    _options;
    _tracerProvider;
    _tracer;
    _conversationIds = new Map();
    // Track root OTel spans per Mastra traceId so children share the same trace
    _rootSpans = new Map();
    constructor(options = {}) {
        super({ logLevel: options.debug ? "debug" : "info" });
        this._options = options;
        const token = options.token || process.env.INTROSPECTION_TOKEN;
        if (!token && !options.advanced?.spanExporter) {
            this.setDisabled("INTROSPECTION_TOKEN is required");
        }
    }
    /**
     * Called by Mastra after the instance is fully configured.
     * We defer TracerProvider creation to here so we can use the service name.
     */
    init(options) {
        if (this.isDisabled)
            return;
        const config = options.config;
        const serviceName = config?.["serviceName"] || "mastra-app";
        this._initProvider(serviceName);
    }
    _initProvider(serviceName) {
        if (this._tracerProvider)
            return; // Already initialized
        const opts = this._options;
        const advanced = opts.advanced;
        const resource = resourceFromAttributes({
            [ATTR_SERVICE_NAME]: serviceName,
        });
        if (advanced?.spanExporter) {
            const sp = advanced.useSimpleSpanProcessor
                ? new SimpleSpanProcessor(advanced.spanExporter)
                : new BatchSpanProcessor(advanced.spanExporter, {
                    scheduledDelayMillis: 100,
                });
            this._tracerProvider = new BasicTracerProvider({
                resource,
                idGenerator: advanced.idGenerator,
                spanProcessors: [sp],
            });
            logger.info("IntrospectionMastraExporter initialized in test mode");
        }
        else {
            const token = opts.token || process.env.INTROSPECTION_TOKEN;
            if (!token)
                return;
            const baseUrl = opts.baseUrl ||
                process.env.INTROSPECTION_BASE_URL ||
                "https://otel.introspection.dev";
            const endpoint = baseUrl.endsWith("/v1/traces")
                ? baseUrl
                : `${baseUrl.replace(/\/$/, "")}/v1/traces`;
            const headers = {
                "User-Agent": `introspection-sdk/${VERSION}`,
                Authorization: `Bearer ${token}`,
                ...opts.additionalHeaders,
            };
            const spanExporter = new OTLPTraceExporter({ url: endpoint, headers });
            const effectiveBatchSize = token.startsWith("intro_dev") || token.startsWith("intro_staging")
                ? 1
                : undefined;
            const useSimple = advanced?.useSimpleSpanProcessor || effectiveBatchSize === 1;
            const sp = useSimple
                ? new SimpleSpanProcessor(spanExporter)
                : new BatchSpanProcessor(spanExporter, {
                    scheduledDelayMillis: 1000,
                    ...(effectiveBatchSize
                        ? { maxExportBatchSize: effectiveBatchSize }
                        : {}),
                });
            this._tracerProvider = new BasicTracerProvider({
                resource,
                idGenerator: advanced?.idGenerator,
                spanProcessors: [sp],
            });
            logger.info(`IntrospectionMastraExporter initialized: endpoint=${endpoint}, serviceName=${serviceName}`);
        }
        this._tracer = this._tracerProvider.getTracer("introspection-mastra", VERSION);
    }
    async _exportTracingEvent(event) {
        if (this.isDisabled)
            return;
        if (event.type !== "span_ended")
            return;
        // Lazy init if init() wasn't called
        if (!this._tracerProvider) {
            this._initProvider("mastra-app");
        }
        if (!this._tracer)
            return;
        this._exportSpan(event.exportedSpan);
    }
    async flush() {
        await this._tracerProvider?.forceFlush();
    }
    async shutdown() {
        // End any open root spans
        for (const span of this._rootSpans.values())
            span.end();
        this._rootSpans.clear();
        await this._tracerProvider?.shutdown();
    }
    // -------------------------------------------------------------------------
    // Span routing
    // -------------------------------------------------------------------------
    _exportSpan(span) {
        switch (span.type) {
            case "agent_run":
                this._exportAgentRun(span);
                break;
            case "model_step":
                this._exportModelStep(span);
                break;
            case "tool_call":
            case "mcp_tool_call":
                this._exportToolCall(span);
                break;
            // model_generation — skipped; model_step has per-step tool calls
            default:
                break;
        }
    }
    // -------------------------------------------------------------------------
    // Span creation with shared trace context
    // -------------------------------------------------------------------------
    /** Ensure a root OTel span exists for this Mastra trace.
     *  Events arrive in end-order (children first, agent_run last),
     *  so we create a synthetic root on first encounter. */
    _ensureRoot(span) {
        if (this._rootSpans.has(span.traceId))
            return;
        const rootSpan = this._tracer.startSpan("trace", {
            startTime: span.startTime,
        });
        this._rootSpans.set(span.traceId, rootSpan);
    }
    _createSpan(span, name) {
        this._ensureRoot(span);
        const parentCtx = otelTrace.setSpan(otelContext.active(), this._rootSpans.get(span.traceId));
        return this._tracer.startSpan(name || span.name, { startTime: span.startTime }, parentCtx);
    }
    // -------------------------------------------------------------------------
    // Span converters
    // -------------------------------------------------------------------------
    _exportAgentRun(span) {
        const attrs = span.attributes;
        const conversationId = this._getConversationId(span);
        // agent_run arrives last — set attrs on the synthetic root and end it
        this._ensureRoot(span);
        const rootSpan = this._rootSpans.get(span.traceId);
        rootSpan.setAttribute("gen_ai.conversation.id", conversationId);
        rootSpan.setAttribute("gen_ai.agent.name", span.entityName || span.name || "agent");
        if (attrs?.["instructions"] && typeof attrs["instructions"] === "string") {
            rootSpan.setAttribute("gen_ai.system_instructions", JSON.stringify([{ type: "text", content: attrs["instructions"] }]));
        }
        // Metadata passthrough
        if (span.metadata) {
            for (const [key, value] of Object.entries(span.metadata)) {
                if (value != null) {
                    rootSpan.setAttribute(`ai.telemetry.metadata.${key}`, typeof value === "string" ? value : JSON.stringify(value));
                }
            }
        }
        rootSpan.end(span.endTime || new Date());
        this._rootSpans.delete(span.traceId);
    }
    _exportModelStep(span) {
        const attrs = span.attributes;
        const conversationId = this._getConversationId(span);
        // Model info lives in metadata.modelMetadata (set by Mastra)
        const modelMeta = span.metadata?.["modelMetadata"];
        const model = modelMeta?.["modelId"] || "";
        const provider = modelMeta?.["modelProvider"] || "";
        // Response metadata from metadata.body (the API response)
        const respBody = span.metadata?.["body"];
        const responseModel = respBody?.["model"] || "";
        const responseId = respBody?.["id"] || "";
        const spanName = model ? `chat ${model}` : span.name;
        const otelSpan = this._createSpan(span, spanName);
        otelSpan.setAttribute("gen_ai.operation.name", "chat");
        otelSpan.setAttribute("gen_ai.conversation.id", conversationId);
        otelSpan.setAttribute("openinference.span.kind", "LLM");
        if (model)
            otelSpan.setAttribute("gen_ai.request.model", model);
        if (provider)
            otelSpan.setAttribute("gen_ai.system", provider);
        if (responseModel)
            otelSpan.setAttribute("gen_ai.response.model", responseModel);
        if (responseId)
            otelSpan.setAttribute("gen_ai.response.id", responseId);
        // Input messages — model_step has input.body.input (raw API messages)
        if (span.input != null) {
            const rawInput = span.input;
            const body = rawInput?.body;
            const apiMessages = body?.input ?? body?.messages;
            if (Array.isArray(apiMessages)) {
                const inputMessages = this._convertInput(apiMessages);
                if (inputMessages.length > 0) {
                    otelSpan.setAttribute("gen_ai.input.messages", JSON.stringify(inputMessages));
                }
                // System instructions
                const systemMsgs = apiMessages.filter((m) => m.role === "system");
                if (systemMsgs.length > 0) {
                    otelSpan.setAttribute("gen_ai.system_instructions", JSON.stringify(systemMsgs.map((m) => ({
                        type: "text",
                        content: typeof m.content === "string"
                            ? m.content
                            : JSON.stringify(m.content),
                    }))));
                }
            }
            // Tool definitions from input.body.tools
            const tools = body?.tools;
            if (Array.isArray(tools) && tools.length > 0) {
                otelSpan.setAttribute("gen_ai.tool.definitions", JSON.stringify(tools.map((t) => ({
                    type: t.type || "function",
                    name: t.name || "",
                    description: t.description || "",
                    parameters: t.parameters,
                }))));
            }
        }
        // Output messages — model_step output has {text, toolCalls} per step
        if (span.output != null) {
            const outputMessages = this._convertOutput(span.output, attrs?.["finishReason"]);
            if (outputMessages.length > 0) {
                otelSpan.setAttribute("gen_ai.output.messages", JSON.stringify(outputMessages));
            }
        }
        // Token usage (per step)
        const usage = attrs?.["usage"];
        if (usage) {
            if (typeof usage["inputTokens"] === "number")
                otelSpan.setAttribute("gen_ai.usage.input_tokens", usage["inputTokens"]);
            if (typeof usage["outputTokens"] === "number")
                otelSpan.setAttribute("gen_ai.usage.output_tokens", usage["outputTokens"]);
            const inputDetails = usage["inputDetails"];
            if (typeof inputDetails?.["cacheRead"] === "number")
                otelSpan.setAttribute("gen_ai.usage.cache_read.input_tokens", inputDetails["cacheRead"]);
        }
        // Finish reason
        const finishReason = attrs?.["finishReason"];
        if (finishReason)
            otelSpan.setAttribute("gen_ai.response.finish_reasons", [finishReason]);
        otelSpan.end(span.endTime || new Date());
    }
    _exportToolCall(span) {
        const conversationId = this._getConversationId(span);
        const toolName = span.entityName || span.name || "tool";
        const otelSpan = this._createSpan(span, toolName);
        otelSpan.setAttribute("gen_ai.tool.name", toolName);
        otelSpan.setAttribute("gen_ai.conversation.id", conversationId);
        otelSpan.setAttribute("openinference.span.kind", "TOOL");
        if (span.input != null) {
            otelSpan.setAttribute("gen_ai.tool.input", typeof span.input === "string"
                ? span.input
                : JSON.stringify(span.input));
        }
        if (span.output != null) {
            otelSpan.setAttribute("gen_ai.tool.output", typeof span.output === "string"
                ? span.output
                : JSON.stringify(span.output));
        }
        otelSpan.end(span.endTime || new Date());
    }
    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------
    _getConversationId(span) {
        const metaConvId = span.metadata?.["gen_ai.conversation.id"];
        if (metaConvId)
            return metaConvId;
        const attrs = span.attributes;
        const attrConvId = attrs?.["conversationId"];
        if (attrConvId)
            return attrConvId;
        const traceId = span.traceId;
        if (!this._conversationIds.has(traceId)) {
            this._conversationIds.set(traceId, `intro_conv_${randomUUID().replace(/-/g, "")}`);
        }
        return this._conversationIds.get(traceId);
    }
    _convertInput(input) {
        if (!input)
            return [];
        if (Array.isArray(input)) {
            const result = [];
            for (const m of input) {
                const msg = m;
                if (!msg)
                    continue;
                // Skip system messages (handled separately)
                if (msg.role === "system")
                    continue;
                // Standard role-based messages
                if (msg.role) {
                    result.push({
                        role: msg.role,
                        parts: this._extractParts(msg.content),
                    });
                    continue;
                }
                // OpenAI Responses API: function_call_output (no role, has type)
                if (msg.type === "function_call_output") {
                    result.push({
                        role: "tool",
                        parts: [
                            {
                                type: "tool_call_response",
                                id: (msg.call_id || ""),
                                response: typeof msg.output === "string"
                                    ? msg.output
                                    : JSON.stringify(msg.output),
                            },
                        ],
                    });
                    continue;
                }
                // item_reference — skip (OpenAI internal reference)
                if (msg.type === "item_reference")
                    continue;
            }
            return result;
        }
        if (typeof input === "string") {
            return [{ role: "user", parts: [{ type: "text", content: input }] }];
        }
        return [];
    }
    _convertOutput(output, finishReason) {
        if (!output)
            return [];
        const parts = [];
        if (typeof output === "string") {
            parts.push({ type: "text", content: output });
        }
        else if (typeof output === "object" && output !== null) {
            const out = output;
            // Reasoning
            if (Array.isArray(out.reasoning)) {
                for (const r of out.reasoning) {
                    const text = (r.text || r.content || "");
                    if (text)
                        parts.push({ type: "thinking", content: text });
                }
            }
            // Text
            if (typeof out.text === "string" && out.text) {
                parts.push({ type: "text", content: out.text });
            }
            // Tool calls
            if (Array.isArray(out.toolCalls)) {
                for (const tc of out.toolCalls) {
                    parts.push({
                        type: "tool_call",
                        name: (tc.toolName || tc.name || ""),
                        id: (tc.toolCallId || tc.id || ""),
                        arguments: typeof tc.args === "string"
                            ? tc.args
                            : JSON.stringify(tc.args || tc.input),
                    });
                }
            }
        }
        if (parts.length === 0)
            return [];
        return [{ role: "assistant", parts, finish_reason: finishReason }];
    }
    _extractParts(content) {
        if (typeof content === "string") {
            return [{ type: "text", content }];
        }
        if (Array.isArray(content)) {
            return content
                .map((part) => {
                const p = part;
                // Standard text
                if (p.type === "text")
                    return {
                        type: "text",
                        content: (p.text || p.content || ""),
                    };
                // OpenAI Responses API input_text format
                if (p.type === "input_text")
                    return {
                        type: "text",
                        content: (p.text || ""),
                    };
                // Tool call
                if (p.type === "tool-call" ||
                    p.type === "tool_call" ||
                    p.type === "function_call")
                    return {
                        type: "tool_call",
                        name: (p.toolName || p.name || ""),
                        id: (p.toolCallId || p.id || p.call_id || ""),
                        arguments: typeof p.args === "string"
                            ? p.args
                            : typeof p.arguments === "string"
                                ? p.arguments
                                : JSON.stringify(p.args || p.arguments || p.input),
                    };
                // Tool result
                if (p.type === "tool-result" ||
                    p.type === "tool_call_response" ||
                    p.type === "function_call_output")
                    return {
                        type: "tool_call_response",
                        id: (p.toolCallId || p.id || p.call_id || ""),
                        response: typeof p.result === "string"
                            ? p.result
                            : typeof p.output === "string"
                                ? p.output
                                : JSON.stringify(p.result || p.output),
                    };
                // item_reference (OpenAI Responses API) — skip
                if (p.type === "item_reference")
                    return null;
                return { type: "text", content: JSON.stringify(p) };
            })
                .filter((p) => p !== null);
        }
        return [];
    }
}
