/**
 * AI SDK TelemetryIntegration for Introspection.
 *
 * Implements the Vercel AI SDK's TelemetryIntegration interface to capture
 * LLM interactions and export them as OpenTelemetry spans with gen_ai.*
 * semantic convention attributes to the Introspection backend.
 *
 * Similar to IntrospectionTracingProcessor for OpenAI Agents SDK and
 * IntrospectionClaudeHooks for Claude Agent SDK.
 *
 * @example
 * ```ts
 * import { IntrospectionAISDKIntegration } from "@introspection-sdk/introspection-node";
 * import { generateText } from "ai";
 * import { openai } from "@ai-sdk/openai";
 *
 * const introspection = new IntrospectionAISDKIntegration({
 *   token: "sk-intro-...",
 *   serviceName: "my-app",
 * });
 *
 * const { text } = await generateText({
 *   model: openai("gpt-4o"),
 *   prompt: "Hello!",
 *   experimental_telemetry: {
 *     isEnabled: true,
 *     integrations: [introspection],
 *   },
 * });
 *
 * await introspection.shutdown();
 * ```
 */
import { type SpanExporter, type IdGenerator } from "@opentelemetry/sdk-trace-base";
/** Advanced options for testing and customization. */
export interface AISDKIntegrationAdvancedOptions {
    /** Custom span exporter (for testing — use InMemorySpanExporter). */
    spanExporter?: SpanExporter;
    /** Custom ID generator (for testing). */
    idGenerator?: IdGenerator;
    /** Use SimpleSpanProcessor instead of BatchSpanProcessor (for testing). */
    useSimpleSpanProcessor?: boolean;
    /** Maximum batch size for span export. */
    maxExportBatchSize?: number;
    /** Delay between batch exports in milliseconds. */
    scheduledDelayMillis?: number;
}
/** Configuration for {@link IntrospectionAISDKIntegration}. */
export interface IntrospectionAISDKIntegrationOptions {
    /** Authentication token (env: INTROSPECTION_TOKEN). */
    token?: string;
    /** Base URL for the API (env: INTROSPECTION_BASE_URL, default: "https://otel.introspection.dev"). */
    baseUrl?: string;
    /** Service name for telemetry (env: INTROSPECTION_SERVICE_NAME). */
    serviceName?: string;
    /** Additional headers to include in requests. */
    additionalHeaders?: Record<string, string>;
    /** Advanced options for testing and customization. */
    advanced?: AISDKIntegrationAdvancedOptions;
}
/**
 * AI SDK {@link TelemetryIntegration} that captures LLM interactions and
 * exports them as OpenTelemetry spans with `gen_ai.*` semantic convention
 * attributes to the Introspection backend.
 *
 * Creates its own {@link BasicTracerProvider} — no external OTel setup required.
 * Each generation (generateText/streamText call) produces:
 * - A root span grouping the entire operation
 * - Step spans (one per LLM call) with full gen_ai attributes
 * - Tool call spans nested under their parent step
 */
export declare class IntrospectionAISDKIntegration {
    private _tracerProvider;
    private _tracer;
    private _generation;
    constructor(options?: IntrospectionAISDKIntegrationOptions);
    /**
     * Called when a generation operation begins (before any LLM calls).
     * Creates a root span to group all steps in this generation.
     */
    onStart: (event: unknown) => void;
    /**
     * Called when a step (individual LLM call) begins.
     * Creates a child span under the root span and captures input messages.
     */
    onStepStart: (event: unknown) => void;
    /**
     * Called when a tool execution begins.
     * Creates a child span under the current step span.
     */
    onToolCallStart: (event: unknown) => void;
    /**
     * Called when a tool execution completes.
     * Sets output/error attributes and ends the tool span.
     */
    onToolCallFinish: (event: unknown) => void;
    /**
     * Called when a step (LLM call) completes.
     * Sets gen_ai attributes (input/output messages, usage, model) and ends
     * the step span.
     */
    onStepFinish: (event: unknown) => void;
    /**
     * Called when the entire generation completes (all steps finished).
     * Sets total usage on the root span and ends it.
     */
    onFinish: (event: unknown) => void;
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
    /** Cleanly end any active generation, closing all open spans. */
    private _endGeneration;
}
//# sourceMappingURL=ai-sdk-integration.d.ts.map