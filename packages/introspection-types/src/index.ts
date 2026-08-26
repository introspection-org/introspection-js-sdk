/**
 * Shared types for the Introspection SDK.
 * Used by both browser and Node.js packages.
 */

import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import type { LogRecordExporter } from "@opentelemetry/sdk-logs";

export { EventType } from "@ag-ui/core";
export type {
  AGUIEvent,
  AgentCapabilities,
  BaseEvent,
  HumanInTheLoopCapabilities,
  Interrupt,
  Message,
  ResumeEntry,
  RunAgentInput,
} from "@ag-ui/core";
export * from "./genai.js";
export * from "./api.js";
export * from "./conversations.js";
export * from "./annotations.js";
export * from "./transcript.js";
export * from "./errors.js";

/**
 * Advanced options for configuration and testing.
 */
export interface AdvancedOptions {
  /** Base URL for the OTLP collector (env: INTROSPECTION_BASE_OTEL_URL, default: "https://otel.introspection.dev") */
  baseUrl?: string;
  /** Base URL for the Control Plane REST API (env: INTROSPECTION_BASE_API_URL, default: "https://api.introspection.dev"). Independent of baseUrl. */
  baseApiUrl?: string;
  /**
   * Data Plane REST base URL returned as `dp_url` by token exchange. Omit only
   * for a local/single-host stack where the Control Plane URL routes both.
   */
  dpUrl?: string;
  /** Flush interval in milliseconds (default: 5000) */
  flushInterval?: number;
  /** Maximum batch size before auto-flush (default: 100) */
  maxBatchSize?: number;
  /**
   * Maximum records buffered before new ones are dropped. Omit to keep the
   * installed OTel SDK's default (2048), including any env-var override it
   * honours.
   *
   * Distinct from {@link maxBatchSize}, which bounds one export rather than
   * the queue behind it. Under a burst larger than the queue, spans and
   * events are dropped silently — this is the knob that raises the ceiling.
   */
  maxQueueSize?: number;
  /**
   * How long one export may take before it is abandoned, in milliseconds.
   * Omit to keep the installed OTel SDK's default (30000).
   */
  exportTimeoutMillis?: number;
  /** Enable debug logging to console */
  debug?: boolean;
  /** Additional HTTP headers to include in requests */
  additionalHeaders?: Record<string, string>;
  /**
   * Custom span exporter (for testing - use InMemorySpanExporter).
   *
   * Node only. The browser client has no span pipeline -- it emits analytics
   * events as OTLP logs; see {@link AdvancedOptions.logExporter}.
   */
  spanExporter?: SpanExporter;
  /**
   * Custom log record exporter (for testing - use InMemoryLogRecordExporter).
   *
   * The analytics stream (`track` / `feedback` / `identify`) is OTLP logs on
   * every platform, so this is the seam for asserting what actually goes out
   * on the wire.
   */
  logExporter?: LogRecordExporter;
  /**
   * Custom `fetch` implementation (for tests or non-Node 18 runtimes).
   *
   * Node only. In the browser, pass `fetch` to the REST client
   * (`IntrospectionApiClient`) instead -- the analytics client reaches the
   * collector through the OTLP exporter, which does not take one.
   */
  fetch?: typeof fetch;
}

/**
 * Configuration options for the Introspection client.
 */
export interface IntrospectionClientOptions {
  /** Authentication token (env: INTROSPECTION_TOKEN) */
  token?: string;
  /**
   * Encoded `intro_cp_session` value returned by the CLI device flow.
   *
   * Node clients use this only for Control Plane requests that require an
   * authenticated business member (for example resolving review assignees by
   * email). Data Plane requests continue to use {@link token}. Never expose
   * this value to browser JavaScript.
   */
  cpSession?: string;
  /** Service name for telemetry (env: INTROSPECTION_SERVICE_NAME, default: "introspection-client") */
  serviceName?: string;
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

/**
 * Coerce a `track` property or `identify` trait into something OTLP can carry.
 *
 * A telemetry call must never silently lose data the caller handed it. The
 * previous inline version kept only object / string / number / boolean and
 * dropped everything else with no attribute emitted at all -- so a `bigint`
 * id, a `symbol`, or a stray function vanished without a trace. `bigint` in
 * particular cannot go through `JSON.stringify`, which throws on it.
 *
 * Native scalars stay native,
 * structured values are JSON, and anything else -- `bigint` included --
 * degrades to a string via the final fallback rather than disappearing.
 */
export function toAttributeValue(value: unknown): string | number | boolean {
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      // Circular, or a BigInt nested inside. A lossy attribute beats a
      // telemetry call throwing into the caller's business logic.
      return String(value);
    }
  }
  return String(value);
}
