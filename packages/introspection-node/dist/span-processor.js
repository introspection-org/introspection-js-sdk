import { propagation, context as otelContext, } from "@opentelemetry/api";
import { BatchSpanProcessor, } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { ExportResultCode } from "@opentelemetry/core";
import { randomUUID } from "crypto";
import { logger } from "./utils.js";
import { isOpenInferenceSpan, replaceOpenInferenceWithGenAI, isVercelAISpan, convertVercelAIToGenAI, } from "./converters/index.js";
/**
 * A {@link ReadableSpan} wrapper that substitutes the original attributes with
 * a converted set while delegating every other property to the original span.
 *
 * Used internally by {@link IntrospectionSpanProcessor} to convert
 * OpenInference attributes to Gen AI semantic conventions on-the-fly.
 */
class ConvertedReadableSpan {
    _original;
    _convertedAttributes;
    _resource;
    constructor(original, convertedAttributes, resource) {
        this._original = original;
        this._convertedAttributes = convertedAttributes;
        this._resource = resource;
    }
    get name() {
        return this._original.name;
    }
    get kind() {
        return this._original.kind;
    }
    spanContext() {
        return this._original.spanContext();
    }
    get startTime() {
        return this._original.startTime;
    }
    get endTime() {
        return this._original.endTime;
    }
    get status() {
        return this._original.status;
    }
    get links() {
        return this._original.links;
    }
    get events() {
        return this._original.events;
    }
    get duration() {
        return this._original.duration;
    }
    get ended() {
        return this._original.ended;
    }
    get resource() {
        return this._resource ?? this._original.resource;
    }
    get instrumentationScope() {
        return this._original.instrumentationScope;
    }
    get droppedAttributesCount() {
        return this._original.droppedAttributesCount;
    }
    get droppedEventsCount() {
        return this._original.droppedEventsCount;
    }
    get droppedLinksCount() {
        return this._original.droppedLinksCount;
    }
    get attributes() {
        return this._convertedAttributes;
    }
}
/**
 * OTel {@link SpanProcessor} that forwards traces to the Introspection backend
 * via OTLP, automatically converting any OpenInference spans to Gen AI
 * semantic convention attributes.
 *
 * @example
 * ```ts
 * import { IntrospectionSpanProcessor } from "@introspection-sdk/introspection-node";
 *
 * const processor = new IntrospectionSpanProcessor({ token: "sk-intro-…" });
 * tracerProvider.addSpanProcessor(processor);
 * ```
 */
export class IntrospectionSpanProcessor {
    _spanProcessor;
    _serviceName;
    _conversationIds = new Map();
    constructor(options = {}) {
        const token = options.token || process.env.INTROSPECTION_TOKEN;
        if (!token) {
            throw new Error("INTROSPECTION_TOKEN is required");
        }
        const serviceName = options.serviceName ||
            process.env.INTROSPECTION_SERVICE_NAME ||
            undefined; // Falls back to TracerProvider's resource
        this._serviceName = serviceName;
        const advanced = options.advanced || {};
        const baseUrl = advanced.baseUrl ||
            process.env.INTROSPECTION_BASE_URL ||
            "https://otel.introspection.dev";
        const headers = {
            Authorization: `Bearer ${token}`,
            ...(advanced.additionalHeaders || {}),
        };
        // Construct endpoint URL
        let endpoint;
        if (baseUrl.endsWith("/v1/traces")) {
            endpoint = baseUrl;
        }
        else {
            endpoint = `${baseUrl.replace(/\/$/, "")}/v1/traces`;
        }
        logger.info(`IntrospectionSpanProcessor initialized: endpoint=${endpoint}${serviceName ? `, serviceName=${serviceName}` : ""}`);
        // Use custom spanExporter if provided (for testing), otherwise create OTLP exporter
        const baseExporter = advanced.spanExporter ||
            new OTLPTraceExporter({
                url: endpoint,
                headers,
            });
        // Wrap exporter to add v1/v2 compatibility and basic validation
        const exporter = {
            export: (spans, resultCallback) => {
                // Filter and fix spans: ensure they have required properties and add v1 compatibility
                const validSpans = spans
                    .filter((span) => {
                    // Basic validation: span must have name and resource
                    if (!span?.name || !span.resource) {
                        return false;
                    }
                    // Must have either instrumentationLibrary or instrumentationScope
                    const compatSpan = span;
                    return !!(compatSpan.instrumentationLibrary ||
                        compatSpan.instrumentationScope);
                })
                    .map((span) => span)
                    .map((span) => {
                    // Compatibility: add instrumentationLibrary for spans that only have instrumentationScope (v2)
                    const compatSpan = span;
                    if (compatSpan.instrumentationScope &&
                        !compatSpan.instrumentationLibrary) {
                        compatSpan.instrumentationLibrary =
                            compatSpan.instrumentationScope;
                    }
                    return span;
                });
                if (validSpans.length === 0) {
                    resultCallback({ code: ExportResultCode.SUCCESS });
                    return;
                }
                // Export with error handling
                try {
                    baseExporter.export(validSpans, (result) => {
                        if (result.code === ExportResultCode.SUCCESS) {
                            logger.debug(`Exported ${validSpans.length} span(s) to ${endpoint}`);
                        }
                        else {
                            logger.error(`Failed to export ${validSpans.length} span(s): ${result.error?.message || "Unknown error"}`);
                        }
                        resultCallback(result);
                    });
                }
                catch (error) {
                    logger.error(`Export error: ${error instanceof Error ? error.message : String(error)}`);
                    resultCallback({
                        code: ExportResultCode.FAILED,
                        error: error instanceof Error ? error : new Error(String(error)),
                    });
                }
            },
            shutdown: () => baseExporter.shutdown(),
            forceFlush: () => {
                if (baseExporter.forceFlush) {
                    return baseExporter.forceFlush();
                }
                return Promise.resolve();
            },
        };
        // Use BatchSpanProcessor like logfire does
        this._spanProcessor = new BatchSpanProcessor(exporter);
    }
    /**
     * Called when a new span is started; delegates to the inner batch processor.
     *
     * @param span - The span that was just started.
     * @param parentContext - The parent {@link Context}.
     */
    onStart(span, parentContext) {
        this._spanProcessor.onStart(span, parentContext);
    }
    /**
     * Called when a span ends. If the span originates from an OpenInference
     * instrumentor, its attributes are converted to `gen_ai.*` semconv keys
     * before being forwarded.
     *
     * @param span - The completed {@link ReadableSpan}.
     */
    onEnd(span) {
        const compatSpan = span;
        const scopeName = compatSpan.instrumentationScope?.name ||
            compatSpan.instrumentationLibrary?.name;
        const isOI = isOpenInferenceSpan(scopeName) ||
            typeof span.attributes["openinference.span.kind"] === "string";
        const isVercel = isVercelAISpan(span.attributes);
        // Skip Vercel AI SDK wrapper spans (ai.streamText, ai.generateText).
        // They duplicate the child doStream/doGenerate output without proper
        // input message windows, causing empty user messages in conversation view.
        // This applies regardless of whether OI attributes are also present.
        const aiOperationId = span.attributes["ai.operationId"];
        if (typeof aiOperationId === "string" &&
            !String(aiOperationId).includes(".do")) {
            return;
        }
        // Skip spans that have no LLM-relevant data — they are infrastructure spans
        // (e.g. Next.js route resolution, HTTP spans) that should not be exported.
        const hasGenAi = isOI ||
            isVercel ||
            span.attributes["gen_ai.system"] != null ||
            span.attributes["gen_ai.operation.name"] != null ||
            span.attributes["gen_ai.request.model"] != null ||
            span.attributes["gen_ai.input.messages"] != null ||
            span.attributes["gen_ai.output.messages"] != null;
        if (!hasGenAi)
            return;
        let attrs;
        if (isOI) {
            attrs = {
                ...replaceOpenInferenceWithGenAI(span.attributes),
            };
            // When both OI and Vercel attrs present, merge Vercel-specific
            // enrichments (conversation ID from metadata, etc.)
            if (isVercel) {
                const vercelAttrs = convertVercelAIToGenAI(span.attributes);
                for (const [key, value] of Object.entries(vercelAttrs)) {
                    // Prefer Vercel output messages when they contain reasoning
                    if (key === "gen_ai.output.messages" &&
                        typeof value === "string" &&
                        value.includes('"thinking"')) {
                        attrs[key] = value;
                    }
                    else if (attrs[key] === undefined) {
                        attrs[key] = value;
                    }
                }
            }
            logger.debug(`Converting OpenInference span: ${span.name}`);
        }
        else if (isVercel) {
            attrs = {
                ...span.attributes,
                ...convertVercelAIToGenAI(span.attributes),
            };
            logger.debug(`Converting Vercel AI span: ${span.name}`);
        }
        else {
            attrs = { ...span.attributes };
        }
        // Read baggage from active context
        const baggage = propagation.getBaggage(otelContext.active());
        // Conversation ID: baggage > existing attr > auto-generate per trace
        const baggageConvId = baggage?.getEntry("gen_ai.conversation.id")?.value;
        const existingConvId = attrs["gen_ai.conversation.id"];
        if (baggageConvId) {
            attrs["gen_ai.conversation.id"] = baggageConvId;
        }
        else if (!existingConvId) {
            const traceId = span.spanContext().traceId;
            if (!this._conversationIds.has(traceId)) {
                this._conversationIds.set(traceId, `intro_conv_${randomUUID().replace(/-/g, "")}`);
            }
            attrs["gen_ai.conversation.id"] = this._conversationIds.get(traceId);
        }
        // Default gen_ai.operation.name to "chat" for spans with messages but no operation name
        if (!attrs["gen_ai.operation.name"] &&
            (attrs["gen_ai.input.messages"] || attrs["gen_ai.output.messages"])) {
            attrs["gen_ai.operation.name"] = "chat";
        }
        // Agent name from baggage
        const baggageAgentName = baggage?.getEntry("gen_ai.agent.name")?.value;
        if (baggageAgentName && !attrs["gen_ai.agent.name"]) {
            attrs["gen_ai.agent.name"] = baggageAgentName;
        }
        // Override resource with service name if provided
        let resource;
        if (this._serviceName) {
            resource = span.resource.merge(resourceFromAttributes({ [ATTR_SERVICE_NAME]: this._serviceName }));
        }
        const processedSpan = new ConvertedReadableSpan(span, attrs, resource);
        this._spanProcessor.onEnd(processedSpan);
    }
    /**
     * Shut down the inner batch processor and its exporter.
     *
     * @returns A promise that resolves once all pending spans are flushed.
     */
    async shutdown() {
        await this._spanProcessor.shutdown();
    }
    /**
     * Force-flush any buffered spans to the Introspection backend.
     *
     * @returns A promise that resolves once the flush completes.
     */
    async forceFlush() {
        await this._spanProcessor.forceFlush();
    }
}
