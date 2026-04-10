/**
 * OpenAI Agents TracingProcessor for Introspection SDK.
 *
 * Forwards OpenAI agent traces to the backend via OTLP with OTel Gen AI semantic
 * convention attributes.
 */
import { context as otelContext, trace as otelTrace, } from "@opentelemetry/api";
import { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { randomUUID } from "crypto";
import { convertResponsesInputsToSemconv, convertResponsesOutputsToSemconv, convertResponsesToolsToSemconv, convertResponsesInstructionsToSemconv, } from "./converters/openai.js";
import { logger } from "./utils.js";
import { VERSION } from "./version.js";
/**
 * {@link TracingProcessor} that forwards OpenAI agent traces to the
 * Introspection backend via OTLP.
 *
 * Extracts OTel Gen AI semantic convention attributes from span data:
 * - Agent spans: `gen_ai.agent.name`, `gen_ai.tool.definitions`, `gen_ai.agent.handoffs`
 * - Function spans: `gen_ai.tool.name`, `gen_ai.tool.input`, `gen_ai.tool.output`
 * - Response spans: `gen_ai.input/output.messages`, `gen_ai.usage.*`, `gen_ai.request.model`
 * - Generation spans: `gen_ai.request.model`, `gen_ai.usage.*`
 * - Handoff spans: `gen_ai.handoff.from_agent`, `gen_ai.handoff.to_agent`
 *
 * @example
 * ```ts
 * import { IntrospectionTracingProcessor } from "@introspection-sdk/introspection-node";
 *
 * const processor = new IntrospectionTracingProcessor({ token: "sk-intro-…" });
 * // pass processor to the OpenAI Agents SDK withTrace() or registerProcessor()
 * ```
 */
export class IntrospectionTracingProcessor {
    _tracerProvider;
    _tracer;
    _spans = new Map();
    _conversationIds = new Map();
    constructor(options = {}) {
        const advanced = options.advanced;
        const serviceName = options.serviceName || process.env.INTROSPECTION_SERVICE_NAME;
        const resource = serviceName
            ? resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName })
            : undefined;
        // If custom exporter is provided (testing mode), skip token validation
        if (!advanced?.spanExporter) {
            const token = options.token || process.env.INTROSPECTION_TOKEN;
            if (!token) {
                throw new Error("INTROSPECTION_TOKEN is required");
            }
            const baseUrl = options.baseUrl ||
                process.env.INTROSPECTION_BASE_URL ||
                "https://otel.introspection.dev";
            const headers = {
                "User-Agent": `introspection-sdk/${VERSION}`,
                Authorization: `Bearer ${token}`,
                ...options.additionalHeaders,
            };
            // Construct endpoint URL
            const endpoint = baseUrl.endsWith("/v1/traces")
                ? baseUrl
                : `${baseUrl.replace(/\/$/, "")}/v1/traces`;
            logger.info(`IntrospectionTracingProcessor initialized: endpoint=${endpoint}`);
            // Setup OTLP exporter
            const spanExporter = new OTLPTraceExporter({
                url: endpoint,
                headers,
            });
            // Use SimpleSpanProcessor for maxExportBatchSize=1 (sequential export),
            // otherwise BatchSpanProcessor with configurable batch size.
            // Default to sequential export for dev/staging tokens.
            const effectiveBatchSize = advanced?.maxExportBatchSize ??
                (token.startsWith("intro_dev") || token.startsWith("intro_staging")
                    ? 1
                    : undefined);
            const useSimple = advanced?.useSimpleSpanProcessor || effectiveBatchSize === 1;
            const scheduledDelayMillis = advanced?.scheduledDelayMillis ?? 1000;
            const spanProcessor = useSimple
                ? new SimpleSpanProcessor(spanExporter)
                : new BatchSpanProcessor(spanExporter, {
                    scheduledDelayMillis,
                    ...(effectiveBatchSize
                        ? { maxExportBatchSize: effectiveBatchSize }
                        : {}),
                });
            this._tracerProvider = new BasicTracerProvider({
                resource,
                idGenerator: advanced?.idGenerator,
                spanProcessors: [spanProcessor],
            });
        }
        else {
            // Testing mode: use provided exporter
            logger.info(`IntrospectionTracingProcessor initialized in test mode with custom exporter`);
            // Choose span processor based on options
            const spanProcessor = advanced.useSimpleSpanProcessor
                ? new SimpleSpanProcessor(advanced.spanExporter)
                : new BatchSpanProcessor(advanced.spanExporter, {
                    scheduledDelayMillis: 100,
                });
            this._tracerProvider = new BasicTracerProvider({
                resource,
                idGenerator: advanced.idGenerator,
                spanProcessors: [spanProcessor],
            });
        }
        this._tracer = this._tracerProvider.getTracer("openai-agents", VERSION);
    }
    /**
     * Called when the processor is started. Optional lifecycle hook.
     */
    start() {
        // No-op - processor is ready after construction
    }
    /**
     * Called when a trace starts. Creates a root OTel span.
     *
     * @param trace - The OpenAI Agents SDK trace object.
     */
    async onTraceStart(trace) {
        logger.debug(`onTraceStart called: ${trace?.name} (${trace?.traceId})`);
        if (trace) {
            const conversationId = `intro_conv_${randomUUID().replace(/-/g, "")}`;
            this._conversationIds.set(trace.traceId, conversationId);
            const otelSpan = this._tracer.startSpan(trace.name);
            this._spans.set(trace.traceId, otelSpan);
            logger.debug(`Created root span for trace: ${trace.traceId}`);
        }
    }
    /**
     * Called when a trace ends. Closes the root OTel span.
     *
     * @param trace - The OpenAI Agents SDK trace object.
     */
    async onTraceEnd(trace) {
        logger.debug(`onTraceEnd called: ${trace?.name} (${trace?.traceId})`);
        if (trace) {
            const otelSpan = this._spans.get(trace.traceId);
            if (otelSpan) {
                this._spans.delete(trace.traceId);
                this._conversationIds.delete(trace.traceId);
                otelSpan.end();
                logger.debug(`Ended root span for trace: ${trace.traceId}`);
            }
        }
    }
    /**
     * Called when a span starts. Creates a child OTel span with parent context.
     *
     * @param span - The OpenAI Agents SDK span.
     */
    async onSpanStart(span) {
        logger.debug(`onSpanStart called: ${span?.spanId} (type: ${span?.spanData?.type})`);
        if (span) {
            const parentId = span.parentId || span.traceId;
            const parent = this._spans.get(parentId);
            const ctx = parent
                ? otelTrace.setSpan(otelContext.active(), parent)
                : undefined;
            const spanData = span.spanData;
            let name;
            // Use name for agent and function spans, type for others
            if (spanData.type === "agent") {
                name = spanData.name;
            }
            else if (spanData.type === "function") {
                name = spanData.name;
            }
            else {
                name = spanData.type;
            }
            const otelSpan = this._tracer.startSpan(name, {}, ctx);
            this._spans.set(span.spanId, otelSpan);
        }
    }
    /**
     * Called when a span ends. Extracts `gen_ai.*` attributes from the span
     * data and sets them on the corresponding OTel span before ending it.
     *
     * @param span - The OpenAI Agents SDK span.
     */
    async onSpanEnd(span) {
        logger.debug(`onSpanEnd called: ${span?.spanId} (type: ${span?.spanData?.type})`);
        if (!span)
            return;
        const otelSpan = this._spans.get(span.spanId);
        if (!otelSpan) {
            logger.debug(`No OTel span found for spanId: ${span.spanId}`);
            return;
        }
        this._spans.delete(span.spanId);
        const spanData = span.spanData;
        // Extract gen_ai.* attributes based on span type
        switch (spanData.type) {
            case "agent":
                this._processAgentSpan(otelSpan, spanData);
                break;
            case "function":
                this._processFunctionSpan(otelSpan, spanData);
                break;
            case "response":
                this._processResponseSpan(otelSpan, spanData);
                break;
            case "generation":
                this._processGenerationSpan(otelSpan, spanData);
                break;
            case "handoff":
                this._processHandoffSpan(otelSpan, spanData);
                break;
        }
        // Propagate conversation ID from trace
        const conversationId = this._conversationIds.get(span.traceId);
        if (conversationId) {
            otelSpan.setAttribute("gen_ai.conversation.id", conversationId);
        }
        // Keep raw span data for debugging (matches Python attribute name)
        otelSpan.setAttribute("openai_agents.span_data", JSON.stringify(spanData));
        otelSpan.end();
    }
    /**
     * Extract attributes from agent spans.
     */
    _processAgentSpan(otelSpan, spanData) {
        otelSpan.setAttribute("gen_ai.agent.name", spanData.name);
        otelSpan.setAttribute("gen_ai.system", "openai");
        otelSpan.setAttribute("openinference.span.kind", "AGENT");
        if (spanData.tools) {
            // Wrap tool names as objects for ClickHouse Array(JSON) compatibility
            const toolDefs = spanData.tools.map((t) => ({ name: t }));
            otelSpan.setAttribute("gen_ai.tool.definitions", JSON.stringify(toolDefs));
        }
        if (spanData.handoffs) {
            otelSpan.setAttribute("gen_ai.agent.handoffs", JSON.stringify(spanData.handoffs));
        }
        if (spanData.output_type) {
            otelSpan.setAttribute("gen_ai.agent.output_type", spanData.output_type);
        }
    }
    /**
     * Extract attributes from function/tool spans.
     */
    _processFunctionSpan(otelSpan, spanData) {
        otelSpan.setAttribute("gen_ai.tool.name", spanData.name);
        otelSpan.setAttribute("openinference.span.kind", "TOOL");
        if (spanData.input) {
            otelSpan.setAttribute("gen_ai.tool.input", spanData.input);
        }
        if (spanData.output) {
            otelSpan.setAttribute("gen_ai.tool.output", String(spanData.output));
        }
    }
    /**
     * Extract attributes from response spans.
     * Matches Python implementation - extracts from both spanData and _response object.
     */
    _processResponseSpan(otelSpan, spanData) {
        otelSpan.setAttribute("gen_ai.operation.name", "chat");
        otelSpan.setAttribute("gen_ai.system", "openai");
        otelSpan.setAttribute("openinference.span.kind", "LLM");
        // Response ID (from span_data directly)
        if (spanData.response_id) {
            otelSpan.setAttribute("gen_ai.response.id", spanData.response_id);
        }
        // Input messages (from spanData._input)
        if (spanData._input) {
            const inputs = Array.isArray(spanData._input)
                ? spanData._input
                : [spanData._input];
            const [inputMessages] = convertResponsesInputsToSemconv(inputs, undefined);
            if (inputMessages.length > 0) {
                otelSpan.setAttribute("gen_ai.input.messages", JSON.stringify(inputMessages));
            }
        }
        // Extract from _response if available (full Response object)
        const response = spanData._response;
        if (!response)
            return;
        // System instructions
        const sysInstructions = convertResponsesInstructionsToSemconv(response.instructions);
        if (sysInstructions) {
            otelSpan.setAttribute("gen_ai.system_instructions", JSON.stringify(sysInstructions));
        }
        // Tool definitions (with full details from Response object)
        if (response.tools && response.tools.length > 0) {
            const toolDefs = convertResponsesToolsToSemconv(response.tools);
            otelSpan.setAttribute("gen_ai.tool.definitions", JSON.stringify(toolDefs));
        }
        // Token usage
        const usage = response.usage;
        if (usage) {
            if (usage.input_tokens) {
                otelSpan.setAttribute("gen_ai.usage.input_tokens", usage.input_tokens);
            }
            if (usage.output_tokens) {
                otelSpan.setAttribute("gen_ai.usage.output_tokens", usage.output_tokens);
            }
        }
        // Model info
        if (response.model) {
            otelSpan.setAttribute("gen_ai.request.model", response.model);
        }
        // Response ID from response object (fallback if not in span_data)
        if (!spanData.response_id && response.id) {
            otelSpan.setAttribute("gen_ai.response.id", response.id);
        }
        // Output messages (from response.output)
        if (response.output && response.output.length > 0) {
            const outputMessages = convertResponsesOutputsToSemconv(response.output);
            if (outputMessages.length > 0) {
                otelSpan.setAttribute("gen_ai.output.messages", JSON.stringify(outputMessages));
            }
        }
    }
    /**
     * Extract attributes from generation spans.
     */
    _processGenerationSpan(otelSpan, spanData) {
        otelSpan.setAttribute("gen_ai.operation.name", "chat");
        otelSpan.setAttribute("gen_ai.system", "openai");
        otelSpan.setAttribute("openinference.span.kind", "LLM");
        if (spanData.model) {
            otelSpan.setAttribute("gen_ai.request.model", spanData.model);
        }
        if (spanData.usage) {
            const usage = spanData.usage;
            if (usage.input_tokens) {
                otelSpan.setAttribute("gen_ai.usage.input_tokens", usage.input_tokens);
            }
            if (usage.output_tokens) {
                otelSpan.setAttribute("gen_ai.usage.output_tokens", usage.output_tokens);
            }
        }
        if (spanData.input) {
            otelSpan.setAttribute("gen_ai.input.messages", JSON.stringify(spanData.input));
        }
        if (spanData.output) {
            otelSpan.setAttribute("gen_ai.output.messages", JSON.stringify(spanData.output));
        }
    }
    /**
     * Extract attributes from handoff spans.
     */
    _processHandoffSpan(otelSpan, spanData) {
        if (spanData.from_agent) {
            otelSpan.setAttribute("gen_ai.handoff.from_agent", spanData.from_agent);
        }
        if (spanData.to_agent) {
            otelSpan.setAttribute("gen_ai.handoff.to_agent", spanData.to_agent);
        }
    }
    /**
     * Shut down the tracer provider, flushing all pending spans.
     *
     * @returns A promise that resolves once shutdown is complete.
     */
    async shutdown() {
        await this._tracerProvider.shutdown();
    }
    /**
     * Force-flush any buffered spans to the Introspection backend.
     *
     * @returns A promise that resolves once the flush completes.
     */
    async forceFlush() {
        await this._tracerProvider.forceFlush();
    }
}
