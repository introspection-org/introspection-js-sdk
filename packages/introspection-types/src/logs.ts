/**
 * The log-event client shared by the Node `IntrospectionLogs` and the browser
 * `IntrospectionClient`: event attributes, `logEvent` / `track` / `feedback`,
 * and the baggage helpers. Each platform supplies its own `LoggerProvider`,
 * identity source and clock.
 *
 * A separate entry point (`@introspection-sdk/types/logs`) because it imports
 * `@opentelemetry/api` at runtime, which the main entry point must not.
 */

import {
  context,
  propagation,
  type Context,
  type TimeInput,
} from "@opentelemetry/api";
import type { LogAttributes, Logger } from "@opentelemetry/api-logs";

import {
  generateEventId,
  reservedEventNamePrefix,
  toAttributeValue,
  type FeedbackOptions,
  type GenAiContext,
  type IdentityContext,
  type LogEventOptions,
  type LogEventSeverity,
} from "./index.js";

/** OTel severity numbers (the logs data model's DEBUG, INFO, WARN, ERROR). */
const SEVERITY_NUMBERS: Record<LogEventSeverity, number> = {
  DEBUG: 5,
  INFO: 9,
  WARN: 13,
  ERROR: 17,
};

/** The OTLP logs URL for a collector base URL, unless it already is one. */
export function logsEndpoint(baseUrl: string): string {
  return baseUrl.endsWith("/v1/logs")
    ? baseUrl
    : `${baseUrl.replace(/\/$/, "")}/v1/logs`;
}

/** Batching options both log clients accept. */
export interface LogBatchOptions {
  flushInterval?: number;
  maxBatchSize?: number;
  maxQueueSize?: number;
  exportTimeoutMillis?: number;
}

/** `BatchLogRecordProcessor` settings, without the exporter. */
export function logBatchConfig(options: LogBatchOptions): {
  maxExportBatchSize: number;
  scheduledDelayMillis: number;
  maxQueueSize?: number;
  exportTimeoutMillis?: number;
} {
  return {
    // maxBatchSize is the export batch size, not the queue bound. Wiring it
    // to maxQueueSize left the queue at 100 while the batch size kept its
    // default of 512, which the OTel processor warns about and clamps on
    // every construction.
    maxExportBatchSize: options.maxBatchSize ?? 100,
    scheduledDelayMillis: options.flushInterval ?? 5000,
    // Passed only when set, so an unset option leaves the OTel SDK's own
    // default (and its env-var override) in charge.
    ...(options.maxQueueSize != null
      ? { maxQueueSize: options.maxQueueSize }
      : {}),
    ...(options.exportTimeoutMillis != null
      ? { exportTimeoutMillis: options.exportTimeoutMillis }
      : {}),
  };
}

/** The value of one baggage entry on the active context. */
export function activeBaggageValue(key: string): string | undefined {
  return propagation.getBaggage(context.active())?.getEntry(key)?.value;
}

function flattenInto(
  attributes: LogAttributes,
  prefix: string,
  values: Record<string, unknown> | undefined,
): void {
  if (!values) return;
  for (const [key, value] of Object.entries(values)) {
    if (value != null) attributes[`${prefix}${key}`] = toAttributeValue(value);
  }
}

/** Inputs to {@link LogEventClient.buildAttributes}. */
export interface EventAttributeOptions {
  properties?: Record<string, unknown>;
  traits?: Record<string, unknown>;
  conversationId?: string;
  previousResponseId?: string;
  eventId?: string;
  /** Identity known at the call site, overriding the context. */
  identity?: IdentityContext;
}

/**
 * Event emission and baggage scoping common to the Node and browser log
 * clients. Not meant to be subclassed outside this SDK.
 */
export abstract class LogEventClient {
  protected abstract otelLogger: Logger;

  /** Identity for an event when the call site gives none. */
  protected abstract getIdentityFromContext(): IdentityContext;

  /** Current time as OTel `HrTime`. */
  protected abstract getTimestamp(): [number, number];

  /** Debug log line after each emitted event. */
  protected abstract debugLog(message: string): void;

  /** Platform attributes placed right after the event name and id. */
  protected platformAttributes(): LogAttributes | undefined {
    return undefined;
  }

  /** Get gen_ai context from baggage */
  protected getGenAiFromContext(): GenAiContext {
    return {
      conversationId: activeBaggageValue("gen_ai.conversation.id"),
      previousResponseId: activeBaggageValue(
        "gen_ai.request.previous_response_id",
      ),
      agentName: activeBaggageValue("gen_ai.agent.name"),
      agentId: activeBaggageValue("gen_ai.agent.id"),
    };
  }

  /** Build log record attributes. */
  protected buildAttributes(
    eventName: string,
    options: EventAttributeOptions = {},
  ): LogAttributes {
    const attributes: LogAttributes = {
      "event.name": eventName,
      "event.id": options.eventId || generateEventId(),
      ...this.platformAttributes(),
    };

    const identity = options.identity ?? this.getIdentityFromContext();
    if (identity.userId) attributes["identity.user.id"] = identity.userId;
    if (identity.anonymousId)
      attributes["identity.anonymous.id"] = identity.anonymousId;

    // Gen AI context (explicit params override baggage)
    const genAi = this.getGenAiFromContext();
    const conversationId = options.conversationId || genAi.conversationId;
    const previousResponseId =
      options.previousResponseId || genAi.previousResponseId;
    if (conversationId) attributes["gen_ai.conversation.id"] = conversationId;
    if (previousResponseId)
      attributes["gen_ai.request.previous_response_id"] = previousResponseId;
    if (genAi.agentName) attributes["gen_ai.agent.name"] = genAi.agentName;
    if (genAi.agentId) attributes["gen_ai.agent.id"] = genAi.agentId;

    flattenInto(attributes, "properties.", options.properties);
    flattenInto(attributes, "context.traits.", options.traits);
    return attributes;
  }

  /** Emit one log record on the active context. */
  protected emit(
    attributes: LogAttributes,
    severity: LogEventSeverity = "INFO",
    timestamp: TimeInput = this.getTimestamp(),
  ): void {
    this.otelLogger.emit({
      timestamp,
      context: context.active(),
      severityNumber: SEVERITY_NUMBERS[severity],
      severityText: severity,
      attributes,
    });
  }

  /**
   * Log an app event under any custom name, e.g. `"ark.feed.entry"`.
   *
   * `attributes` land under `properties.*`, which is where the platform's
   * `introspection.track` read projection finds them; read the events back
   * with `client.events.list({ event_name: "introspection.track" })`.
   * Identity and gen_ai context are taken from the active context unless
   * `options.identity` overrides them.
   *
   * Pass a stable `options.eventId` when delivery may repeat: consumers
   * dedupe on it, so re-sending the same id is safe.
   *
   * @throws Error when `name` is empty or falls under a reserved namespace
   *   (`introspection.*`, `gen_ai.*`).
   *
   * @example
   * ```ts
   * client.logEvent("checkout.completed", { orderId: "o_1", total: 42 });
   * ```
   */
  logEvent(
    name: string,
    attributes?: Record<string, unknown>,
    options: LogEventOptions = {},
  ): void {
    if (!name) {
      throw new Error("logEvent: event name must be a non-empty string.");
    }
    const reserved = reservedEventNamePrefix(name);
    if (reserved) {
      throw new Error(
        `logEvent: event name "${name}" is in the reserved "${reserved}*" namespace, which belongs to the platform and OpenTelemetry. Use your own prefix, e.g. "myapp.${name.slice(reserved.length)}".`,
      );
    }
    const contextIdentity = this.getIdentityFromContext();
    this.emit(
      this.buildAttributes(name, {
        properties: attributes,
        eventId: options.eventId,
        identity: {
          userId: options.identity?.userId ?? contextIdentity.userId,
          anonymousId:
            options.identity?.anonymousId ?? contextIdentity.anonymousId,
        },
      }),
      options.severity,
      options.timestamp,
    );
    this.debugLog(`Logged event: ${name}`);
  }

  /**
   * Track a custom event. A thin alias of {@link logEvent} kept for the
   * Segment-style call shape.
   *
   * @param eventName - The event name (e.g., `"Button Clicked"`).
   * @param properties - Optional properties to attach to the event.
   * @param options - Optional overrides (e.g., custom `eventId`).
   *
   * @example
   * ```ts
   * client.track("Button Clicked", { buttonId: "submit" });
   * ```
   */
  track(
    eventName: string,
    properties?: Record<string, unknown>,
    options?: { eventId?: string },
  ): void {
    this.logEvent(eventName, properties, { eventId: options?.eventId });
  }

  /**
   * Track feedback on a message or response.
   *
   * gen_ai.conversation.id, gen_ai.request.previous_response_id, and agent context
   * are automatically extracted from baggage if not provided explicitly.
   *
   * @param name - Feedback name/action (e.g., "thumbs_up", "thumbs_down")
   * @param options - Optional feedback options
   *
   * @example
   * ```typescript
   * // Simple feedback
   * client.feedback("thumbs_up");
   *
   * // With comments
   * client.feedback("thumbs_down", { comments: "Off topic" });
   *
   * // With explicit gen_ai context
   * client.feedback("thumbs_up", {
   *   conversationId: "conv_456",
   *   previousResponseId: "msg_123",
   * });
   *
   * // With baggage context
   * await client.withConversation("conv_456", undefined, async () => {
   *   client.feedback("thumbs_up"); // auto-includes conversation_id
   * });
   * ```
   */
  feedback(name: string, options: FeedbackOptions = {}): void {
    const { comments, conversationId, previousResponseId, eventId, ...extra } =
      options;
    // `name` last: it is the positional argument, so an `extra` key that
    // happens to be called `name` must not silently replace the feedback
    // name the caller passed.
    const properties: Record<string, unknown> = { ...extra, name };
    // `!= null`, not truthiness: `comments: ""` is a comment the caller
    // supplied. Dropping it here made the same call produce a different event
    // shape per SDK.
    if (comments != null) properties.comments = comments;
    this.emit(
      this.buildAttributes("introspection.feedback", {
        properties,
        conversationId: conversationId as string | undefined,
        previousResponseId: previousResponseId as string | undefined,
        eventId: eventId as string | undefined,
      }),
    );
    this.debugLog(`Feedback: ${name}`);
  }

  /**
   * Create a context with baggage values set.
   * Use with context.with() to run code in that context.
   *
   * Note: In browsers, automatic context propagation requires Zone.js.
   * Without it, you must manually pass context through async operations.
   *
   * @param values - Key/value pairs to set as baggage
   * @returns Context with baggage set
   *
   * @example
   * ```typescript
   * const ctx = client.createBaggageContext({
   *   "gen_ai.agent.name": "support-bot",
   *   "gen_ai.conversation.id": "conv_456"
   * });
   *
   * await context.with(ctx, async () => {
   *   client.feedback("thumbs_up"); // picks up baggage
   * });
   * ```
   */
  createBaggageContext(values: Record<string, string>): Context {
    const ctx = context.active();
    let bag = propagation.getBaggage(ctx) || propagation.createBaggage();
    for (const [key, value] of Object.entries(values)) {
      bag = bag.setEntry(key, { value });
    }
    return propagation.setBaggage(ctx, bag);
  }

  /**
   * Helper to set multiple baggage values and run a callback.
   *
   * @param values - Key/value pairs to set as baggage.
   * @param callback - Function to run with baggage context.
   * @returns The return value of the callback.
   *
   * @example
   * ```typescript
   * await client.withBaggage({
   *   "gen_ai.conversation.id": "conv_456",
   *   "gen_ai.request.previous_response_id": "resp_123"
   * }, async () => {
   *   client.feedback("thumbs_up");
   * });
   * ```
   */
  async withBaggage<T>(
    values: Record<string, string>,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    const ctx = this.createBaggageContext(values);
    return await context.with(ctx, callback);
  }

  /**
   * Helper to set agent baggage and run a callback.
   *
   * @param agentName - Name of the agent.
   * @param agentId - Optional unique identifier for the agent.
   * @param callback - Function to run with agent context.
   * @returns The return value of the callback.
   *
   * @example
   * ```typescript
   * await client.withAgent("support-bot", "agent_123", async () => {
   *   client.feedback("thumbs_up");
   * });
   * ```
   */
  async withAgent<T>(
    agentName: string,
    agentId: string | undefined,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    const values: Record<string, string> = { "gen_ai.agent.name": agentName };
    if (agentId) values["gen_ai.agent.id"] = agentId;
    return await this.withBaggage(values, callback);
  }

  /**
   * Helper to set conversation baggage and run a callback.
   *
   * @param conversationId - Unique identifier for the conversation (optional).
   * @param previousResponseId - Previous response ID for conversation continuity (optional).
   * @param callback - Function to run with conversation context.
   * @returns The return value of the callback.
   *
   * @example
   * ```typescript
   * // Simple conversation context
   * await client.withConversation("conv_456", undefined, async () => {
   *   client.feedback("thumbs_up");
   * });
   *
   * // With previous response for conversation continuity
   * await client.withConversation("conv_456", "resp_123", async () => {
   *   client.feedback("thumbs_up");
   * });
   * ```
   */
  async withConversation<T>(
    conversationId: string | undefined,
    previousResponseId: string | undefined,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    const values: Record<string, string> = {};
    if (conversationId) values["gen_ai.conversation.id"] = conversationId;
    if (previousResponseId)
      values["gen_ai.request.previous_response_id"] = previousResponseId;
    return await this.withBaggage(values, callback);
  }

  /**
   * Helper to set user ID baggage and run a callback.
   *
   * @param userId - User identifier.
   * @param callback - Function to run with user context.
   * @returns The return value of the callback.
   *
   * @example
   * ```typescript
   * await client.withUserId("user_123", async () => {
   *   client.feedback("thumbs_up");
   * });
   * ```
   */
  async withUserId<T>(
    userId: string,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    return await this.withBaggage({ "identity.user_id": userId }, callback);
  }

  /**
   * Helper to set anonymous ID baggage and run a callback.
   *
   * @param anonymousId - Anonymous visitor identifier.
   * @param callback - Function to run with anonymous context.
   * @returns The return value of the callback.
   *
   * @example
   * ```ts
   * await client.withAnonymousId("anon-abc", async () => {
   *   client.feedback("thumbs_up");
   * });
   * ```
   */
  async withAnonymousId<T>(
    anonymousId: string,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    return await this.withBaggage(
      { "identity.anonymous_id": anonymousId },
      callback,
    );
  }
}
