/**
 * Introspection Client for Node.js
 * Provides an API for tracking events and feedback using OTLP Logs.
 *
 * Identity and gen_ai context are automatically extracted from OpenTelemetry
 * baggage.
 */
import { type IntrospectionClientOptions, type FeedbackOptions, type UserTraits } from "./types.js";
/**
 * Introspection client for tracking events and feedback using OTLP Logs.
 *
 * @example
 * ```typescript
 * const client = new IntrospectionClient({
 *   token: process.env.INTROSPECTION_TOKEN,
 * });
 *
 * client.identify("user_123", { email: "user@example.com" });
 * client.feedback("thumbs_up", { comments: "Great response!" });
 *
 * await client.shutdown();
 * ```
 */
export declare class IntrospectionClient {
    private loggerProvider;
    private otelLogger;
    private userId;
    private anonymousId;
    private traits;
    constructor(options?: IntrospectionClientOptions);
    /** Get gen_ai context from baggage */
    private getGenAiFromContext;
    /** Get identity from baggage or client instance */
    private getIdentityFromContext;
    /**
     * Get current timestamp as OpenTelemetry HrTime.
     * Uses process.hrtime.bigint() for nanosecond precision in Node.js.
     */
    private getTimestamp;
    /**
     * Build log record attributes.
     */
    private buildAttributes;
    /**
     * Track a custom event.
     *
     * @param eventName - A descriptive name for the event (e.g. `"page_view"`).
     * @param properties - Arbitrary key/value pairs attached to the event.
     * @param options - Optional overrides such as a custom `eventId`.
     */
    track(eventName: string, properties?: Record<string, unknown>, options?: {
        eventId?: string;
    }): void;
    /**
     * Track feedback on a message or response.
     *
     * @param name - Feedback type (e.g. `"thumbs_up"`, `"thumbs_down"`).
     * @param options - Additional feedback context such as comments or conversation ID.
     */
    feedback(name: string, options?: FeedbackOptions): void;
    /**
     * Identify a user and associate traits with them.
     *
     * @param userId - Unique identifier for the user.
     * @param traits - Key/value user properties (e.g. `{ email: "…" }`).
     * @param anonymousId - Optional anonymous identifier to link pre-auth sessions.
     * @param eventId - Optional custom event ID override.
     */
    identify(userId: string, traits?: UserTraits, anonymousId?: string, eventId?: string): void;
    /**
     * Create an OTel context with the given baggage values set.
     *
     * @param values - Key/value pairs to store in OTel baggage.
     * @returns A new context containing the baggage entries.
     */
    createBaggageContext(values: Record<string, string>): import("@opentelemetry/api").Context;
    /**
     * Set multiple baggage values and run a callback within that context.
     *
     * @param values - Key/value pairs to store in OTel baggage.
     * @param callback - Function to execute with the baggage context active.
     * @returns The value returned by `callback`.
     */
    withBaggage<T>(values: Record<string, string>, callback: () => T | Promise<T>): Promise<T>;
    /**
     * Set `gen_ai.agent.name` (and optionally `gen_ai.agent.id`) baggage and run
     * a callback within that context.
     *
     * @param agentName - The agent name to propagate.
     * @param agentId - Optional agent identifier.
     * @param callback - Function to execute with the agent baggage active.
     * @returns The value returned by `callback`.
     */
    withAgent<T>(agentName: string, agentId: string | undefined, callback: () => T | Promise<T>): Promise<T>;
    /**
     * Set conversation-related baggage (`gen_ai.conversation.id`,
     * `gen_ai.request.previous_response_id`) and run a callback within that
     * context.
     *
     * @param conversationId - The conversation identifier.
     * @param previousResponseId - The ID of the previous response in the conversation.
     * @param callback - Function to execute with the conversation baggage active.
     * @returns The value returned by `callback`.
     */
    withConversation<T>(conversationId: string | undefined, previousResponseId: string | undefined, callback: () => T | Promise<T>): Promise<T>;
    /**
     * Set the user ID on this client instance.
     *
     * @param userId - Unique identifier for the user.
     */
    setUserId(userId: string): void;
    /**
     * Set the anonymous ID on this client instance.
     *
     * @param anonymousId - Anonymous identifier used before authentication.
     */
    setAnonymousId(anonymousId: string): void;
    /**
     * Set `identity.user_id` baggage and run a callback within that context.
     *
     * @param userId - The user identifier to propagate.
     * @param callback - Function to execute with the user-ID baggage active.
     * @returns The value returned by `callback`.
     */
    withUserId<T>(userId: string, callback: () => T | Promise<T>): Promise<T>;
    /**
     * Set `identity.anonymous_id` baggage and run a callback within that context.
     *
     * @param anonymousId - The anonymous identifier to propagate.
     * @param callback - Function to execute with the anonymous-ID baggage active.
     * @returns The value returned by `callback`.
     */
    withAnonymousId<T>(anonymousId: string, callback: () => T | Promise<T>): Promise<T>;
    /**
     * Get the current anonymous ID stored on this client instance.
     *
     * @returns The anonymous ID, or `undefined` if not set.
     */
    getAnonymousId(): string | undefined;
    /**
     * Reset all client-side state (user ID, anonymous ID, and traits).
     */
    reset(): void;
    /**
     * Flush all queued log records to the backend.
     *
     * @returns A promise that resolves once the flush completes.
     */
    flush(): Promise<void>;
    /**
     * Shut down the client, flushing all pending log records.
     *
     * @returns A promise that resolves once shutdown is complete.
     */
    shutdown(): Promise<void>;
}
//# sourceMappingURL=client.d.ts.map