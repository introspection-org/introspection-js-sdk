/**
 * OpenAI Agents TracingProcessor for Introspection SDK.
 *
 * Forwards OpenAI agent traces to the backend via OTLP with OTel Gen AI semantic
 * convention attributes.
 */
import { type SpanExporter, type IdGenerator } from "@opentelemetry/sdk-trace-base";
import type { TracingProcessor, Trace, Span, SpanData } from "@openai/agents";
/**
 * Advanced options for testing and customization of
 * {@link IntrospectionTracingProcessor}.
 */
export interface TracingProcessorAdvancedOptions {
    /** Custom span exporter (for testing - use InMemorySpanExporter) */
    spanExporter?: SpanExporter;
    /** Custom ID generator (for testing - use IncrementalIdGenerator) */
    idGenerator?: IdGenerator;
    /** Use SimpleSpanProcessor instead of BatchSpanProcessor (for testing) */
    useSimpleSpanProcessor?: boolean;
    /**
     * Maximum number of spans to export in a single batch.
     * Set to 1 to export each span individually on end, ensuring sequential
     * processing by the backend (useful for multi-turn conversations where
     * each turn must be ingested before the next arrives).
     * Defaults to the OTel SDK default (512).
     */
    maxExportBatchSize?: number;
    /**
     * Delay interval in milliseconds between batch exports.
     * Lower values reduce latency but increase network requests.
     * Defaults to 1000.
     */
    scheduledDelayMillis?: number;
}
/** Configuration for {@link IntrospectionTracingProcessor}. */
export interface IntrospectionTracingProcessorOptions {
    /** Authentication token (env: INTROSPECTION_TOKEN) */
    token?: string;
    /** Base URL for the API (env: INTROSPECTION_BASE_URL, default: "https://otel.introspection.dev") */
    baseUrl?: string;
    /** Service name for telemetry (env: INTROSPECTION_SERVICE_NAME) */
    serviceName?: string;
    /** Additional headers to include in requests */
    additionalHeaders?: Record<string, string>;
    /** Advanced options for testing and customization */
    advanced?: TracingProcessorAdvancedOptions;
}
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
export declare class IntrospectionTracingProcessor implements TracingProcessor {
    private _tracerProvider;
    private _tracer;
    private _spans;
    private _conversationIds;
    constructor(options?: IntrospectionTracingProcessorOptions);
    /**
     * Called when the processor is started. Optional lifecycle hook.
     */
    start(): void;
    /**
     * Called when a trace starts. Creates a root OTel span.
     *
     * @param trace - The OpenAI Agents SDK trace object.
     */
    onTraceStart(trace: Trace): Promise<void>;
    /**
     * Called when a trace ends. Closes the root OTel span.
     *
     * @param trace - The OpenAI Agents SDK trace object.
     */
    onTraceEnd(trace: Trace): Promise<void>;
    /**
     * Called when a span starts. Creates a child OTel span with parent context.
     *
     * @param span - The OpenAI Agents SDK span.
     */
    onSpanStart(span: Span<SpanData>): Promise<void>;
    /**
     * Called when a span ends. Extracts `gen_ai.*` attributes from the span
     * data and sets them on the corresponding OTel span before ending it.
     *
     * @param span - The OpenAI Agents SDK span.
     */
    onSpanEnd(span: Span<SpanData>): Promise<void>;
    /**
     * Extract attributes from agent spans.
     */
    private _processAgentSpan;
    /**
     * Extract attributes from function/tool spans.
     */
    private _processFunctionSpan;
    /**
     * Extract attributes from response spans.
     * Matches Python implementation - extracts from both spanData and _response object.
     */
    private _processResponseSpan;
    /**
     * Extract attributes from generation spans.
     */
    private _processGenerationSpan;
    /**
     * Extract attributes from handoff spans.
     */
    private _processHandoffSpan;
    /**
     * Shut down the tracer provider, flushing all pending spans.
     *
     * @returns A promise that resolves once shutdown is complete.
     */
    shutdown(): Promise<void>;
    /**
     * Force-flush any buffered spans to the Introspection backend.
     *
     * @returns A promise that resolves once the flush completes.
     */
    forceFlush(): Promise<void>;
}
//# sourceMappingURL=tracing-processor.d.ts.map