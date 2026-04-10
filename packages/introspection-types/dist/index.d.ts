/**
 * Shared types for the Introspection SDK.
 * Used by both browser and Node.js packages.
 */
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
/**
 * Advanced options for configuration and testing.
 *
 * @example
 * ```ts
 * const options: AdvancedOptions = {
 *   baseUrl: "https://custom.endpoint.dev",
 *   debug: true,
 *   flushInterval: 2000,
 * };
 * ```
 */
export interface AdvancedOptions {
    /** Base URL for the API (env: INTROSPECTION_BASE_URL, default: "https://otel.introspection.dev") */
    baseUrl?: string;
    /** Flush interval in milliseconds (default: 5000) */
    flushInterval?: number;
    /** Maximum batch size before auto-flush (default: 100) */
    maxBatchSize?: number;
    /** Enable debug logging to console */
    debug?: boolean;
    /** Additional HTTP headers to include in requests */
    additionalHeaders?: Record<string, string>;
    /** Custom span exporter (for testing - use InMemorySpanExporter) */
    spanExporter?: SpanExporter;
    /**
     * Delay interval in milliseconds between batch exports.
     * Lower values reduce latency but increase network requests.
     * Defaults to 1000.
     */
    scheduledDelayMillis?: number;
}
/**
 * Configuration options for the Introspection client.
 *
 * @example
 * ```ts
 * const options: IntrospectionClientOptions = {
 *   token: "sk-intro-...",
 *   serviceName: "my-app",
 * };
 * ```
 */
export interface IntrospectionClientOptions {
    /** Authentication token (env: INTROSPECTION_TOKEN) */
    token?: string;
    /** Service name for telemetry (env: INTROSPECTION_SERVICE_NAME, default: "introspection-client") */
    serviceName?: string;
    /** Advanced options for configuration and testing */
    advanced?: AdvancedOptions;
}
/**
 * Options for the {@link IntrospectionClient.feedback} method.
 *
 * @example
 * ```ts
 * const opts: FeedbackOptions = {
 *   comments: "Answer was off topic",
 *   conversationId: "conv-123",
 * };
 * ```
 */
export interface FeedbackOptions {
    /** User's comments (e.g., "Answer was off topic") */
    comments?: string;
    /** Conversation/session ID (falls back to baggage context) */
    conversationId?: string;
    /** ID of the response being given feedback on (explicit only) */
    previousResponseId?: string;
    /** Custom event ID (auto-generated if not provided) */
    eventId?: string;
    /** Additional custom data */
    [key: string]: unknown;
}
/**
 * User identity traits passed to {@link IntrospectionClient.identify}.
 *
 * Standard fields (`email`, `name`, `plan`) are provided for convenience;
 * additional custom traits can be added via the index signature.
 *
 * @example
 * ```ts
 * const traits: UserTraits = {
 *   email: "user@example.com",
 *   name: "Jane Doe",
 *   plan: "pro",
 *   company: "Acme Inc",
 * };
 * ```
 */
export interface UserTraits {
    /** User's email address. */
    email?: string;
    /** User's display name. */
    name?: string;
    /** User's subscription plan. */
    plan?: string;
    /** Additional custom traits. */
    [key: string]: unknown;
}
/**
 * Gen AI context values extracted from OpenTelemetry baggage.
 *
 * @example
 * ```ts
 * const ctx: GenAiContext = {
 *   conversationId: "conv-123",
 *   previousResponseId: "resp-456",
 *   agentName: "support-agent",
 *   agentId: undefined,
 * };
 * ```
 */
export interface GenAiContext {
    /** Active conversation / session identifier. */
    conversationId: string | undefined;
    /** ID of the previous model response in the conversation. */
    previousResponseId: string | undefined;
    /** Name of the currently active agent. */
    agentName: string | undefined;
    /** Unique identifier of the currently active agent. */
    agentId: string | undefined;
}
/**
 * User identity context extracted from OpenTelemetry baggage.
 *
 * @example
 * ```ts
 * const identity: IdentityContext = {
 *   userId: "user-789",
 *   anonymousId: "anon-abc",
 * };
 * ```
 */
export interface IdentityContext {
    /** Authenticated user identifier set via {@link IntrospectionClient.identify}. */
    userId: string | undefined;
    /** Anonymous visitor identifier, auto-generated or explicitly set. */
    anonymousId: string | undefined;
}
/**
 * Generate a unique event ID.
 *
 * @returns A string in the format `intro_event_<hex-timestamp>-<8-char-random-hex>`.
 *
 * @example
 * ```ts
 * const id = generateEventId();
 * // "intro_event_1a2b3c4d-f9e80a1b"
 * ```
 */
export declare function generateEventId(): string;
/**
 * Standard log attribute keys used by the Introspection SDK.
 *
 * These follow OpenTelemetry semantic conventions where applicable.
 *
 * @example
 * ```ts
 * logRecord.setAttribute(Attr.CONVERSATION_ID, "conv-123");
 * logRecord.setAttribute(Attr.USER_ID, "user-456");
 * ```
 */
export declare const Attr: {
    readonly EVENT_NAME: "event.name";
    readonly EVENT_ID: "event.id";
    readonly USER_ID: "identity.user.id";
    readonly ANONYMOUS_ID: "identity.anonymous.id";
    readonly CONVERSATION_ID: "gen_ai.conversation.id";
    readonly PREVIOUS_RESPONSE_ID: "gen_ai.request.previous_response_id";
    readonly AGENT_NAME: "gen_ai.agent.name";
    readonly AGENT_ID: "gen_ai.agent.id";
    readonly PROPERTIES_PREFIX: "properties.";
    readonly TRAITS_PREFIX: "context.traits.";
};
/**
 * Baggage keys used for OpenTelemetry context propagation.
 *
 * Identity keys use underscores instead of dots for baggage compatibility.
 *
 * @example
 * ```ts
 * baggage.setEntry(Baggage.CONVERSATION_ID, { value: "conv-123" });
 * ```
 */
export declare const Baggage: {
    readonly USER_ID: "identity.user_id";
    readonly ANONYMOUS_ID: "identity.anonymous_id";
    readonly CONVERSATION_ID: "gen_ai.conversation.id";
    readonly PREVIOUS_RESPONSE_ID: "gen_ai.request.previous_response_id";
    readonly AGENT_NAME: "gen_ai.agent.name";
    readonly AGENT_ID: "gen_ai.agent.id";
};
/**
 * Standard event names emitted by the Introspection SDK.
 *
 * @example
 * ```ts
 * logRecord.setAttribute(Attr.EVENT_NAME, EventName.FEEDBACK);
 * ```
 */
export declare const EventName: {
    readonly IDENTIFY: "identify";
    readonly FEEDBACK: "introspection.feedback";
};
/**
 * Default configuration fallback values used when options are not explicitly provided.
 *
 * @example
 * ```ts
 * const interval = options.flushInterval ?? Defaults.FLUSH_INTERVAL_MS;
 * ```
 */
export declare const Defaults: {
    readonly SERVICE_NAME: "introspection-client";
    readonly BASE_URL: "https://otel.introspection.dev";
    readonly FLUSH_INTERVAL_MS: 5000;
    readonly MAX_BATCH_SIZE: 100;
};
/**
 * Log severity text constants for OTel log records.
 *
 * @example
 * ```ts
 * logRecord.setSeverityText(Severity.INFO);
 * ```
 */
export declare const Severity: {
    readonly INFO: "INFO";
};
/**
 * OpenTelemetry instrumentation scope (logger) names, one per SDK package.
 *
 * @example
 * ```ts
 * const logger = loggerProvider.getLogger(LoggerName.NODE_SDK);
 * ```
 */
export declare const LoggerName: {
    readonly NODE_SDK: "@introspection-sdk/introspection-node";
    readonly BROWSER_SDK: "@introspection-sdk/introspection-browser";
};
/**
 * HTTP API endpoint paths appended to the base URL.
 *
 * @example
 * ```ts
 * const url = `${baseUrl}${ApiPath.LOGS}`;
 * ```
 */
export declare const ApiPath: {
    readonly LOGS: "/v1/logs";
};
/**
 * `localStorage` keys used by the browser SDK to persist identity data.
 *
 * @example
 * ```ts
 * const anonId = localStorage.getItem(StorageKey.ANONYMOUS_ID);
 * ```
 */
export declare const StorageKey: {
    readonly ANONYMOUS_ID: "introspection_anonymous_id";
    readonly USER_ID: "introspection_user_id";
    readonly TRAITS: "introspection_traits";
};
//# sourceMappingURL=index.d.ts.map