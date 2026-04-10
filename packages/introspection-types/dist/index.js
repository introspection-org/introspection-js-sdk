/**
 * Shared types for the Introspection SDK.
 * Used by both browser and Node.js packages.
 */
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
export function generateEventId() {
    const timestamp = Date.now().toString(16);
    const random = Math.random().toString(16).substring(2, 10);
    return `intro_event_${timestamp}-${random}`;
}
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
export const Attr = {
    // Core event fields
    EVENT_NAME: "event.name",
    EVENT_ID: "event.id",
    // Identity
    USER_ID: "identity.user.id",
    ANONYMOUS_ID: "identity.anonymous.id",
    // Gen AI (OTel semantic conventions)
    CONVERSATION_ID: "gen_ai.conversation.id",
    PREVIOUS_RESPONSE_ID: "gen_ai.request.previous_response_id",
    AGENT_NAME: "gen_ai.agent.name",
    AGENT_ID: "gen_ai.agent.id",
    // Prefixes for dynamic keys
    PROPERTIES_PREFIX: "properties.",
    TRAITS_PREFIX: "context.traits.",
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
export const Baggage = {
    USER_ID: "identity.user_id",
    ANONYMOUS_ID: "identity.anonymous_id",
    CONVERSATION_ID: "gen_ai.conversation.id",
    PREVIOUS_RESPONSE_ID: "gen_ai.request.previous_response_id",
    AGENT_NAME: "gen_ai.agent.name",
    AGENT_ID: "gen_ai.agent.id",
};
/**
 * Standard event names emitted by the Introspection SDK.
 *
 * @example
 * ```ts
 * logRecord.setAttribute(Attr.EVENT_NAME, EventName.FEEDBACK);
 * ```
 */
export const EventName = {
    IDENTIFY: "identify",
    FEEDBACK: "introspection.feedback",
};
/**
 * Default configuration fallback values used when options are not explicitly provided.
 *
 * @example
 * ```ts
 * const interval = options.flushInterval ?? Defaults.FLUSH_INTERVAL_MS;
 * ```
 */
export const Defaults = {
    SERVICE_NAME: "introspection-client",
    BASE_URL: "https://otel.introspection.dev",
    FLUSH_INTERVAL_MS: 5000,
    MAX_BATCH_SIZE: 100,
};
/**
 * Log severity text constants for OTel log records.
 *
 * @example
 * ```ts
 * logRecord.setSeverityText(Severity.INFO);
 * ```
 */
export const Severity = {
    INFO: "INFO",
};
/**
 * OpenTelemetry instrumentation scope (logger) names, one per SDK package.
 *
 * @example
 * ```ts
 * const logger = loggerProvider.getLogger(LoggerName.NODE_SDK);
 * ```
 */
export const LoggerName = {
    NODE_SDK: "@introspection-sdk/introspection-node",
    BROWSER_SDK: "@introspection-sdk/introspection-browser",
};
/**
 * HTTP API endpoint paths appended to the base URL.
 *
 * @example
 * ```ts
 * const url = `${baseUrl}${ApiPath.LOGS}`;
 * ```
 */
export const ApiPath = {
    LOGS: "/v1/logs",
};
/**
 * `localStorage` keys used by the browser SDK to persist identity data.
 *
 * @example
 * ```ts
 * const anonId = localStorage.getItem(StorageKey.ANONYMOUS_ID);
 * ```
 */
export const StorageKey = {
    ANONYMOUS_ID: "introspection_anonymous_id",
    USER_ID: "introspection_user_id",
    TRAITS: "introspection_traits",
};
