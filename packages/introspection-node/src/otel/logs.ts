/**
 * IntrospectionLogs — OTel logs exporter for Introspection.
 *
 * Owns its own `LoggerProvider` and OTLP log exporter. Provides `track`,
 * `feedback`, `identify`, and async-context helpers (`withBaggage`,
 * `withAgent`, `withConversation`, etc.) that propagate identity and
 * gen_ai context through OpenTelemetry baggage.
 *
 * Fully independent of {@link IntrospectionClient}. Construct it directly
 * with the OTel peer dependencies installed.
 *
 * @example
 * ```typescript
 * import { IntrospectionLogs } from "@introspection-sdk/introspection-node/otel";
 *
 * const logs = new IntrospectionLogs({
 *   token: process.env.INTROSPECTION_TOKEN,
 *   serviceName: "my-service",
 * });
 *
 * await logs.withAgent("support-bot", "agent_1", () =>
 *   logs.withConversation("conv_123", undefined, () => {
 *     logs.feedback("thumbs_up", { comments: "Great answer" });
 *   }),
 * );
 *
 * await logs.shutdown();
 * ```
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

import { logger as sdkLogger, withOtlpHttpsProxy } from "../utils.js";
import { VERSION } from "../version.js";
import {
  generateEventId,
  type FeedbackOptions,
  type UserTraits,
  type GenAiContext,
  type IdentityContext,
} from "../types.js";

/**
 * Configuration for {@link IntrospectionLogs}.
 */
export interface IntrospectionLogsOptions {
  /** Authentication token (env: INTROSPECTION_TOKEN). */
  token?: string;
  /** Service name for telemetry (env: INTROSPECTION_SERVICE_NAME, default: "introspection-client"). */
  serviceName?: string;
  /**
   * Base URL for the OTLP collector (env: INTROSPECTION_BASE_OTEL_URL,
   * default: "https://otel.introspection.dev").
   */
  baseOtelUrl?: string;
  /** Optional project id (for downstream attribute tagging only). */
  projectId?: string;
  /** Additional HTTP headers to include in exporter requests. */
  additionalHeaders?: Record<string, string>;
  /** Flush interval in milliseconds (default: 5000). */
  flushInterval?: number;
  /** Maximum queue size before auto-flush (default: 100). */
  maxBatchSize?: number;
}

export class IntrospectionLogs {
  private loggerProvider: LoggerProvider;
  private otelLogger: ReturnType<LoggerProvider["getLogger"]>;
  private userId: string | undefined;
  private anonymousId: string | undefined;
  private traits: Record<string, unknown> = {};
  private readonly projectId: string | undefined;

  constructor(options: IntrospectionLogsOptions = {}) {
    const token = options.token || process.env.INTROSPECTION_TOKEN || "";
    const serviceName =
      options.serviceName ||
      process.env.INTROSPECTION_SERVICE_NAME ||
      "introspection-client";
    this.projectId =
      options.projectId || process.env.INTROSPECTION_PROJECT_ID || undefined;
    const baseOtelUrl =
      options.baseOtelUrl ||
      process.env.INTROSPECTION_BASE_OTEL_URL ||
      "https://otel.introspection.dev";

    if (!token) {
      sdkLogger.warn(
        "IntrospectionLogs: No token provided. Events will not be sent.",
      );
    }

    // Construct endpoint URL for logs.
    const endpoint = baseOtelUrl.endsWith("/v1/logs")
      ? baseOtelUrl
      : `${baseOtelUrl.replace(/\/$/, "")}/v1/logs`;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      ...(options.additionalHeaders || {}),
    };

    const exporter = new OTLPLogExporter(
      withOtlpHttpsProxy({
        url: endpoint,
        headers,
      }),
    );

    const processor = new BatchLogRecordProcessor(exporter, {
      maxQueueSize: options.maxBatchSize ?? 100,
      scheduledDelayMillis: options.flushInterval ?? 5000,
    });

    const baseResource = defaultResource();
    const introspectionResource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
    });
    const resource = baseResource.merge(introspectionResource);

    this.loggerProvider = new LoggerProvider({
      resource,
      processors: [processor],
    });

    this.otelLogger = this.loggerProvider.getLogger(
      "@introspection-sdk/introspection-node",
      VERSION,
    );

    sdkLogger.info(
      `IntrospectionLogs initialized: service=${serviceName}, otlp=${endpoint}`,
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

  /** Get identity from baggage or instance state */
  private getIdentityFromContext(): IdentityContext {
    const baggage = propagation.getBaggage(context.active());
    return {
      userId: baggage?.getEntry("identity.user_id")?.value || this.userId,
      anonymousId:
        baggage?.getEntry("identity.anonymous_id")?.value || this.anonymousId,
    };
  }

  private getTimestamp(): [number, number] {
    const hrTimeNs = process.hrtime.bigint();
    const epochNs = BigInt(Date.now()) * BigInt(1_000_000);
    const offsetNs = hrTimeNs - process.hrtime.bigint() + epochNs;
    const seconds = Number(offsetNs / BigInt(1_000_000_000));
    const nanos = Number(offsetNs % BigInt(1_000_000_000));
    return [seconds, nanos];
  }

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

    const attributes: LogAttributes = {
      "event.name": eventName,
      "event.id": eventId || generateEventId(),
    };

    const identity = this.getIdentityFromContext();
    if (identity.userId) attributes["identity.user.id"] = identity.userId;
    if (identity.anonymousId)
      attributes["identity.anonymous.id"] = identity.anonymousId;

    const genAi = this.getGenAiFromContext();
    const finalConversationId = conversationId || genAi.conversationId;
    const finalPreviousResponseId =
      previousResponseId || genAi.previousResponseId;

    if (finalConversationId)
      attributes["gen_ai.conversation.id"] = finalConversationId;
    if (finalPreviousResponseId)
      attributes["gen_ai.request.previous_response_id"] =
        finalPreviousResponseId;
    if (genAi.agentName) attributes["gen_ai.agent.name"] = genAi.agentName;
    if (genAi.agentId) attributes["gen_ai.agent.id"] = genAi.agentId;

    if (this.projectId) attributes["introspection.project.id"] = this.projectId;

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

  feedback(name: string, options: FeedbackOptions = {}): void {
    const { comments, conversationId, previousResponseId, eventId, ...extra } =
      options;
    const properties: Record<string, unknown> = { name, ...extra };
    if (comments) properties.comments = comments;
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

  identify(
    userId: string,
    traits?: UserTraits,
    anonymousId?: string,
    eventId?: string,
  ): void {
    this.userId = userId;
    if (anonymousId) this.anonymousId = anonymousId;
    if (traits) this.traits = { ...this.traits, ...traits };
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

  createBaggageContext(values: Record<string, string>) {
    const ctx = context.active();
    let bag = propagation.getBaggage(ctx) || propagation.createBaggage();
    for (const [key, value] of Object.entries(values)) {
      bag = bag.setEntry(key, { value });
    }
    return propagation.setBaggage(ctx, bag);
  }

  async withBaggage<T>(
    values: Record<string, string>,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    const ctx = this.createBaggageContext(values);
    return await context.with(ctx, callback);
  }

  async withAgent<T>(
    agentName: string,
    agentId: string | undefined,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    const values: Record<string, string> = { "gen_ai.agent.name": agentName };
    if (agentId) values["gen_ai.agent.id"] = agentId;
    return await context.with(this.createBaggageContext(values), callback);
  }

  async withConversation<T>(
    conversationId: string | undefined,
    previousResponseId: string | undefined,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    const values: Record<string, string> = {};
    if (conversationId) values["gen_ai.conversation.id"] = conversationId;
    if (previousResponseId)
      values["gen_ai.request.previous_response_id"] = previousResponseId;
    return await context.with(this.createBaggageContext(values), callback);
  }

  setUserId(userId: string): void {
    this.userId = userId;
  }

  setAnonymousId(anonymousId: string): void {
    this.anonymousId = anonymousId;
  }

  async withUserId<T>(
    userId: string,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    return await context.with(
      this.createBaggageContext({ "identity.user_id": userId }),
      callback,
    );
  }

  async withAnonymousId<T>(
    anonymousId: string,
    callback: () => T | Promise<T>,
  ): Promise<T> {
    return await context.with(
      this.createBaggageContext({ "identity.anonymous_id": anonymousId }),
      callback,
    );
  }

  getAnonymousId(): string | undefined {
    return this.anonymousId;
  }

  reset(): void {
    this.userId = undefined;
    this.anonymousId = undefined;
    this.traits = {};
    sdkLogger.debug("IntrospectionLogs state reset");
  }

  async flush(): Promise<void> {
    await this.loggerProvider.forceFlush();
    sdkLogger.debug("Flushed pending log records");
  }

  async shutdown(): Promise<void> {
    await this.loggerProvider.shutdown();
    sdkLogger.debug("IntrospectionLogs shutdown complete");
  }
}
