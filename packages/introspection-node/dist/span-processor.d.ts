import { Context } from "@opentelemetry/api";
import { SpanProcessor, ReadableSpan, Span } from "@opentelemetry/sdk-trace-base";
import type { AdvancedOptions } from "./types.js";
export interface IntrospectionSpanProcessorOptions {
    /** Authentication token (env: INTROSPECTION_TOKEN) */
    token?: string;
    /**
     * Service name for telemetry (env: INTROSPECTION_SERVICE_NAME).
     * Note: For spans, the service name is typically set on the TracerProvider's resource.
     * This option is provided for consistency but the TracerProvider's resource takes precedence.
     */
    serviceName?: string;
    /** Advanced options for configuration and testing */
    advanced?: AdvancedOptions;
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
export declare class IntrospectionSpanProcessor implements SpanProcessor {
    private _spanProcessor;
    private _serviceName?;
    private _conversationIds;
    constructor(options?: IntrospectionSpanProcessorOptions);
    /**
     * Called when a new span is started; delegates to the inner batch processor.
     *
     * @param span - The span that was just started.
     * @param parentContext - The parent {@link Context}.
     */
    onStart(span: Span, parentContext: Context): void;
    /**
     * Called when a span ends. If the span originates from an OpenInference
     * instrumentor, its attributes are converted to `gen_ai.*` semconv keys
     * before being forwarded.
     *
     * @param span - The completed {@link ReadableSpan}.
     */
    onEnd(span: ReadableSpan): void;
    /**
     * Shut down the inner batch processor and its exporter.
     *
     * @returns A promise that resolves once all pending spans are flushed.
     */
    shutdown(): Promise<void>;
    /**
     * Force-flush any buffered spans to the Introspection backend.
     *
     * @returns A promise that resolves once the flush completes.
     */
    forceFlush(): Promise<void>;
}
//# sourceMappingURL=span-processor.d.ts.map