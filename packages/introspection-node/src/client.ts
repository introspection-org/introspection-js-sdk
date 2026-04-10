/**
 * Introspection Client for Node.js
 * Provides an API for tracking events and feedback using OTLP Logs.
 *
 * Identity and gen_ai context are automatically extracted from OpenTelemetry
 * baggage.
 */

import { SeverityNumber, type LogAttributes } from "@opentelemetry/api-logs";
import {
  LoggerProvider,
  BatchLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import {
  resourceFromAttributes,
  defaultResource,
} from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { propagation, context } from "@opentelemetry/api";
import { logger as sdkLogger } from "./utils.js";
import { VERSION } from "./version.js";
import {
  generateEventId,
  type IntrospectionClientOptions,
  type FeedbackOptions,
  type UserTraits,
  type GenAiContext,
  type IdentityContext,
} from "./types.js";

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
export class IntrospectionClient {
  private loggerProvider: LoggerProvider;
  private otelLogger: ReturnType<LoggerProvider["getLogger"]>;
  private userId: string | undefined;
  private anonymousId: string | undefined;
  private traits: Record<string, unknown> = {};

  constructor(options: IntrospectionClientOptions = {}) {
    const token = options.token || process.env.INTROSPECTION_TOKEN || "";
    const serviceName =
      options.serviceName ||
      process.env.INTROSPECTION_SERVICE_NAME ||
      "introspection-client";
    const advanced = options.advanced || {};
    const baseUrl =
      advanced.baseUrl ||
      process.env.INTROSPECTION_BASE_URL ||
      "https://otel.introspection.dev";

    if (!token) {
      sdkLogger.warn(
        "IntrospectionClient: No token provided. Events will not be sent.",
      );
    }

    // Construct endpoint URL for logs
    let endpoint: string;
    if (baseUrl.endsWith("/v1/logs")) {
      endpoint = baseUrl;
    } else {
      endpoint = `${baseUrl.replace(/\/$/, "")}/v1/logs`;
    }

    // Build headers
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (advanced.additionalHeaders) {
      Object.assign(headers, advanced.additionalHeaders);
    }

    // Create OTLP log exporter
    const exporter = new OTLPLogExporter({
      url: endpoint,
      headers,
    });

    // Create batch processor
    const processor = new BatchLogRecordProcessor(exporter, {
      maxQueueSize: advanced.maxBatchSize ?? 100,
      scheduledDelayMillis: advanced.flushInterval ?? 5000,
    });

    // Get default resource and merge with our service name
    const baseResource = defaultResource();
    const introspectionResource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
    });
    const resource = baseResource.merge(introspectionResource);

    // Create logger provider
    this.loggerProvider = new LoggerProvider({
      resource,
      processors: [processor],
    });

    this.otelLogger = this.loggerProvider.getLogger(
      "@introspection-sdk/introspection-node",
      VERSION,
    );

    sdkLogger.info(
      `IntrospectionClient initialized: service=${serviceName}, endpoint=${endpoint}`,
    );
  }

  /** Get gen_ai context from baggage */
  private getGenAiFromContext(): GenAiContext {
    const baggage = propagation.getBaggage(context.active());
    return {
      conversationId: baggage?.getEntry("gen_ai.conversation.id")?.value,
      previousResponseId: baggage?.getEntry(
        "gen_ai.request.previous_response_id",
      )?.value,
      agentName: baggage?.getEntry("gen_ai.agent.name")?.value,
      agentId: baggage?.getEntry("gen_ai.agent.id")?.value,
    };
  }

  /** Get identity from baggage or client instance */
  private getIdentityFromContext(): IdentityContext {
    const baggage = propagation.getBaggage(context.active());
    return {
      userId: baggage?.getEntry("identity.user_id")?.value || this.userId,
      anonymousId:
        baggage?.getEntry("identity.anonymous_id")?.value || this.anonymousId,
    };
  }

  /**
   * Get current timestamp as OpenTelemetry HrTime.
   * Uses process.hrtime.bigint() for nanosecond precision in Node.js.
   */
  private getTimestamp(): [number, number] {
    const hrTimeNs = process.hrtime.bigint();
    const epochNs = BigInt(Date.now()) * BigInt(1_000_000);
    const offsetNs = hrTimeNs - process.hrtime.bigint() + epochNs;
    const seconds = Number(offsetNs / BigInt(1_000_000_000));
    const nanos = Number(offsetNs % BigInt(1_000_000_000));
    return [seconds, nanos];
  }

  /**
   * Build log record attributes.
   */
  private buildAttributes(
    eventName: string,
    options: {
      properties?: Record<string, unknown>;
      traits?: Record<string, unknown>;
      conversationId?: string;
      previousResponseId?: string;
      eventId?: string;
    } = {},
  ): LogAttributes {
    const { properties, traits, conversationId, previousResponseId, eventId } =
      options;

    // Core fields
    const attributes: LogAttributes = {
      "event.name": eventName,
      "event.id": eventId || generateEventId(),
    };

    // Identity
    const identity = this.getIdentityFromContext();
    if (identity.userId) {
      attributes["identity.user.id"] = identity.userId;
    }
    if (identity.anonymousId) {
      attributes["identity.anonymous.id"] = identity.anonymousId;
    }

    // Gen AI context (explicit params override baggage)
    const genAi = this.getGenAiFromContext();
    const finalConversationId = conversationId || genAi.conversationId;
    const finalPreviousResponseId =
      previousResponseId || genAi.previousResponseId;

    if (finalConversationId) {
      attributes["gen_ai.conversation.id"] = finalConversationId;
    }
    if (finalPreviousResponseId) {
      attributes["gen_ai.request.previous_response_id"] =
        finalPreviousResponseId;
    }
    if (genAi.agentName) {
      attributes["gen_ai.agent.name"] = genAi.agentName;
    }
    if (genAi.agentId) {
      attributes["gen_ai.agent.id"] = genAi.agentId;
    }

    // Flatten properties with "properties." prefix
    if (properties) {
      for (const [key, value] of Object.entries(properties)) {
        if (value != null) {
          const attrKey = `properties.${key}`;
          if (typeof value === "object") {
            attributes[attrKey] = JSON.stringify(value);
          } else if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          ) {
            attributes[attrKey] = value;
          }
        }
      }
    }

    // Flatten traits with "context.traits." prefix
    if (traits) {
      for (const [key, value] of Object.entries(traits)) {
        if (value != null) {
          const attrKey = `context.traits.${key}`;
          if (typeof value === "object") {
            attributes[attrKey] = JSON.stringify(value);
          } else if (
            typeof value === "string" ||
            typeof value === "number" ||
            typeof value === "boolean"
          ) {
            attributes[attrKey] = value;
          }
        }
      }
    }

    return attributes;
  }

  /**
   * Track a custom event.
   *
   * @param eventName - A descriptive name for the event (e.g. `"page_view"`).
   * @param properties - Arbitrary key/value pairs attached to the event.
   * @param options - Optional overrides such as a custom `eventId`.
   */
  track(
    eventName: string,
    properties?: Record<string, unknown>,
    options?: { eventId?: string },
  ): void {
    const attributes = this.buildAttributes(eventName, {
      properties,
      eventId: options?.eventId,
    });

    this.otelLogger.emit({
      timestamp: this.getTimestamp(),
      context: context.active(),
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      attributes,
    });

    sdkLogger.debug(`Tracked: ${eventName}`);
  }

  /**
   * Track feedback on a message or response.
   *
   * @param name - Feedback type (e.g. `"thumbs_up"`, `"thumbs_down"`).
   * @param options - Additional feedback context such as comments or conversation ID.
   */
  feedback(name: string, options: FeedbackOptions = {}): void {
    const { comments, conversationId, previousResponseId, eventId, ...extra } =
      options;

    const properties: Record<string, unknown> = { name, ...extra };
    if (comments) {
      properties.comments = comments;
    }

    const attributes = this.buildAttributes("introspection.feedback", {
      properties,
      conversationId: conversationId as string | undefined,
      previousResponseId: previousResponseId as string | undefined,
      eventId: eventId as string | undefined,
    });

    this.otelLogger.emit({
      timestamp: this.getTimestamp(),
      context: context.active(),
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      attributes,
    });

    sdkLogger.debug(`Feedback: ${name}`);
  }

  /**
   * Identify a user and associate traits with them.
   *
   * @param userId - Unique identifier for the user.
   * @param traits - Key/value user properties (e.g. `{ email: "…" }`).
   * @param anonymousId - Optional anonymous identifier to link pre-auth sessions.
   * @param eventId - Optional custom event ID override.
   */
  identify(
    userId: string,
    traits?: UserTraits,
    anonymousId?: string,
    eventId?: string,
  ): void {
    this.userId = userId;
    if (anonymousId) {
      this.anonymousId = anonymousId;
    }
    if (traits) {
      this.traits = { ...this.traits, ...traits };
    }

    const attributes = this.buildAttributes("identify", { traits, eventId });

    this.otelLogger.emit({
      timestamp: this.getTimestamp(),
      context: context.active(),
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      attributes,
    });

    sdkLogger.debug(`Identified: ${userId}`);
  }

  /**
   * Create an OTel context with the given baggage values set.
   *
   * @param values - Key/value pairs to store in OTel baggage.
   * @returns A new context containing the baggage entries.
   */
  createBaggageContext(values: Record<string, string>) {
    const ctx = context.active();
    let bag = propagation.getBaggage(ctx) || propagation.createBaggage();

    for (const [key, value] of Object.entries(values)) {
      bag = bag.setEntry(key, { value });
    }

    return propagation.setBaggage(ctx, bag);
  }

  /**
   * Set multiple baggage values and run a callback within that context.
   *
   * @param values - Key/value pairs to store in OTel baggage.
   * @param callback - Function to execute with the baggage context active.
   * @returns The value returned by `callback`.
   */
  async withBaggage<T>(
    values: Record<string, string>,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    const ctx = this.createBaggageContext(values);
    return await context.with(ctx, callback);
  }

  /**
   * Set `gen_ai.agent.name` (and optionally `gen_ai.agent.id`) baggage and run
   * a callback within that context.
   *
   * @param agentName - The agent name to propagate.
   * @param agentId - Optional agent identifier.
   * @param callback - Function to execute with the agent baggage active.
   * @returns The value returned by `callback`.
   */
  async withAgent<T>(
    agentName: string,
    agentId: string | undefined,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    const values: Record<string, string> = { "gen_ai.agent.name": agentName };
    if (agentId) {
      values["gen_ai.agent.id"] = agentId;
    }
    return await context.with(this.createBaggageContext(values), callback);
  }

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
  async withConversation<T>(
    conversationId: string | undefined,
    previousResponseId: string | undefined,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    const values: Record<string, string> = {};
    if (conversationId) {
      values["gen_ai.conversation.id"] = conversationId;
    }
    if (previousResponseId) {
      values["gen_ai.request.previous_response_id"] = previousResponseId;
    }
    return await context.with(this.createBaggageContext(values), callback);
  }

  /**
   * Set the user ID on this client instance.
   *
   * @param userId - Unique identifier for the user.
   */
  setUserId(userId: string): void {
    this.userId = userId;
  }

  /**
   * Set the anonymous ID on this client instance.
   *
   * @param anonymousId - Anonymous identifier used before authentication.
   */
  setAnonymousId(anonymousId: string): void {
    this.anonymousId = anonymousId;
  }

  /**
   * Set `identity.user_id` baggage and run a callback within that context.
   *
   * @param userId - The user identifier to propagate.
   * @param callback - Function to execute with the user-ID baggage active.
   * @returns The value returned by `callback`.
   */
  async withUserId<T>(
    userId: string,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    return await context.with(
      this.createBaggageContext({ "identity.user_id": userId }),
      callback,
    );
  }

  /**
   * Set `identity.anonymous_id` baggage and run a callback within that context.
   *
   * @param anonymousId - The anonymous identifier to propagate.
   * @param callback - Function to execute with the anonymous-ID baggage active.
   * @returns The value returned by `callback`.
   */
  async withAnonymousId<T>(
    anonymousId: string,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    return await context.with(
      this.createBaggageContext({ "identity.anonymous_id": anonymousId }),
      callback,
    );
  }

  /**
   * Get the current anonymous ID stored on this client instance.
   *
   * @returns The anonymous ID, or `undefined` if not set.
   */
  getAnonymousId(): string | undefined {
    return this.anonymousId;
  }

  /**
   * Reset all client-side state (user ID, anonymous ID, and traits).
   */
  reset(): void {
    this.userId = undefined;
    this.anonymousId = undefined;
    this.traits = {};
    sdkLogger.debug("Client state reset");
  }

  /**
   * Flush all queued log records to the backend.
   *
   * @returns A promise that resolves once the flush completes.
   */
  async flush(): Promise<void> {
    await this.loggerProvider.forceFlush();
    sdkLogger.debug("Flushed pending log records");
  }

  /**
   * Shut down the client, flushing all pending log records.
   *
   * @returns A promise that resolves once shutdown is complete.
   */
  async shutdown(): Promise<void> {
    await this.loggerProvider.shutdown();
    sdkLogger.debug("IntrospectionClient shutdown complete");
  }
}
