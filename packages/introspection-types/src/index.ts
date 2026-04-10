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
export function generateEventId(): string {
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
} as const;

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
} as const;

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
} as const;

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
} as const;

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
} as const;

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
} as const;

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
} as const;

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
} as const;
