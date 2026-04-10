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
import type { TracingEvent, InitExporterOptions } from "@mastra/core/observability";
import { type SpanExporter, type IdGenerator } from "@opentelemetry/sdk-trace-base";
/** Advanced options for testing and customization. */
export interface MastraExporterAdvancedOptions {
    /** Custom span exporter for testing. */
    spanExporter?: SpanExporter;
    /** Custom ID generator for testing. */
    idGenerator?: IdGenerator;
    /** Use SimpleSpanProcessor instead of BatchSpanProcessor. */
    useSimpleSpanProcessor?: boolean;
}
/** Configuration for {@link IntrospectionMastraExporter}. */
export interface IntrospectionMastraExporterOptions {
    /** Authentication token (env: INTROSPECTION_TOKEN). */
    token?: string;
    /** Base URL for the API (env: INTROSPECTION_BASE_URL). */
    baseUrl?: string;
    /** Additional headers to include in requests. */
    additionalHeaders?: Record<string, string>;
    /** Enable debug logging. */
    debug?: boolean;
    /** Advanced options for testing. */
    advanced?: MastraExporterAdvancedOptions;
}
export declare class IntrospectionMastraExporter extends BaseExporter {
    name: string;
    private _options;
    private _tracerProvider?;
    private _tracer?;
    private _conversationIds;
    private _rootSpans;
    constructor(options?: IntrospectionMastraExporterOptions);
    /**
     * Called by Mastra after the instance is fully configured.
     * We defer TracerProvider creation to here so we can use the service name.
     */
    init(options: InitExporterOptions): void;
    private _initProvider;
    protected _exportTracingEvent(event: TracingEvent): Promise<void>;
    flush(): Promise<void>;
    shutdown(): Promise<void>;
    private _exportSpan;
    /** Ensure a root OTel span exists for this Mastra trace.
     *  Events arrive in end-order (children first, agent_run last),
     *  so we create a synthetic root on first encounter. */
    private _ensureRoot;
    private _createSpan;
    private _exportAgentRun;
    private _exportModelStep;
    private _exportToolCall;
    private _getConversationId;
    private _convertInput;
    private _convertOutput;
    private _extractParts;
}
//# sourceMappingURL=mastra-exporter.d.ts.map