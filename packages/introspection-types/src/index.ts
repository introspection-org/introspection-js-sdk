/**
 * Shared types for the Introspection SDK.
 * Used by both browser and Node.js packages.
 */

import type { SpanExporter } from "@opentelemetry/sdk-trace-base";

export * from "./genai.js";
export * from "./api.js";
export * from "./conversations.js";
export * from "./errors.js";

/**
 * Advanced options for configuration and testing.
 */
export interface AdvancedOptions {
  /** Base URL for the OTLP collector (env: INTROSPECTION_BASE_OTEL_URL, default: "https://otel.introspection.dev") */
  baseUrl?: string;
  /** Base URL for the DP REST API (env: INTROSPECTION_BASE_API_URL, default: "https://api.introspection.dev"). Independent of baseUrl. */
  baseApiUrl?: string;
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
  /** Custom `fetch` implementation (for tests or non-Node 18 runtimes). */
  fetch?: typeof fetch;
}

/**
 * Configuration options for the Introspection client.
 */
export interface IntrospectionClientOptions {
  /** Authentication token (env: INTROSPECTION_TOKEN) */
  token?: string;
  /** Service name for telemetry (env: INTROSPECTION_SERVICE_NAME, default: "introspection-client") */
  serviceName?: string;
  /**
   * Default project id. Required by `client.runtimes(name)` when the
   * argument is a runtime name instead of a UUID — the SDK needs to know
   * which project to scope the lookup to. May be omitted if you always
   * pass UUIDs to `runtimes(id)` and pass `project_id` explicitly to the
   * CRUD helpers.
   */
  projectId?: string;
  /** Advanced options for configuration and testing */
  advanced?: AdvancedOptions;
}

/**
 * Options for the {@link IntrospectionClient.feedback} method.
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
 */
export interface GenAiContext {
  conversationId: string | undefined;
  previousResponseId: string | undefined;
  agentName: string | undefined;
  agentId: string | undefined;
}

/**
 * User identity context extracted from OpenTelemetry baggage.
 */
export interface IdentityContext {
  userId: string | undefined;
  anonymousId: string | undefined;
}

/**
 * Generate a unique event ID.
 */
export function generateEventId(): string {
  const timestamp = Date.now().toString(16);
  const random = Math.random().toString(16).substring(2, 10);
  return `intro_event_${timestamp}-${random}`;
}

export const Attr = {
  EVENT_NAME: "event.name",
  EVENT_ID: "event.id",
  USER_ID: "identity.user.id",
  ANONYMOUS_ID: "identity.anonymous.id",
  CONVERSATION_ID: "gen_ai.conversation.id",
  PREVIOUS_RESPONSE_ID: "gen_ai.request.previous_response_id",
  AGENT_NAME: "gen_ai.agent.name",
  AGENT_ID: "gen_ai.agent.id",
  PROPERTIES_PREFIX: "properties.",
  TRAITS_PREFIX: "context.traits.",
} as const;

export const Baggage = {
  USER_ID: "identity.user_id",
  ANONYMOUS_ID: "identity.anonymous_id",
  CONVERSATION_ID: "gen_ai.conversation.id",
  PREVIOUS_RESPONSE_ID: "gen_ai.request.previous_response_id",
  AGENT_NAME: "gen_ai.agent.name",
  AGENT_ID: "gen_ai.agent.id",
} as const;

export const EventName = {
  IDENTIFY: "identify",
  FEEDBACK: "introspection.feedback",
} as const;

export const Defaults = {
  SERVICE_NAME: "introspection-client",
  BASE_URL: "https://otel.introspection.dev",
  BASE_API_URL: "https://api.introspection.dev",
  FLUSH_INTERVAL_MS: 5000,
  MAX_BATCH_SIZE: 100,
} as const;

export const Severity = {
  INFO: "INFO",
} as const;

export const LoggerName = {
  NODE_SDK: "@introspection-sdk/introspection-node",
  BROWSER_SDK: "@introspection-sdk/introspection-browser",
} as const;

/**
 * HTTP API endpoint paths appended to the base URL.
 */
export const ApiPath = {
  LOGS: "/v1/logs",
  TASKS: "/v1/tasks",
  FILES: "/v1/files",
} as const;

export const StorageKey = {
  ANONYMOUS_ID: "introspection_anonymous_id",
  USER_ID: "introspection_user_id",
  TRAITS: "introspection_traits",
} as const;
