/**
 * Introspection Client for Browser
 * Provides an API for tracking events and feedback using OTLP Logs.
 *
 * Identity and gen_ai context can be managed via baggage (requires OpenTelemetry
 * browser SDK with Zone.js for automatic propagation) or via client instance.
 */

import { SeverityNumber, type LogAttributes } from "@opentelemetry/api-logs";
import {
  LoggerProvider,
  BatchLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import { propagation, context } from "@opentelemetry/api";
import { VERSION } from "./version.js";
import {
  generateEventId,
  type IntrospectionClientOptions,
  type FeedbackOptions,
  type UserTraits,
  type GenAiContext,
  type IdentityContext,
} from "./types.js";

const ANONYMOUS_ID_KEY = "introspection_anonymous_id";
const USER_ID_KEY = "introspection_user_id";
const TRAITS_KEY = "introspection_traits";

/**
 * Generate a UUID-like anonymous ID
 */
function generateAnonymousId(): string {
  const segments = [];
  for (let i = 0; i < 4; i++) {
    segments.push(Math.random().toString(16).substring(2, 6));
  }
  return segments.join("-");
}

/**
 * Simple logger that respects debug flag
 */
class Logger {
  constructor(private debug: boolean) {}

  log(...args: unknown[]): void {
    if (this.debug) {
      console.log("[introspection-sdk]", ...args);
    }
  }

  warn(...args: unknown[]): void {
    console.warn("[introspection-sdk]", ...args);
  }

  error(...args: unknown[]): void {
    console.error("[introspection-sdk]", ...args);
  }
}

/**
 * Introspection client for tracking events and feedback in the browser using OTLP Logs.
 *
 * Identity (user_id, anonymous_id) and gen_ai context (conversation_id, previous_response_id, agent)
 * can be managed via client instance (persisted to localStorage) or via OpenTelemetry baggage
 * for scoped context.
 *
 * Note: Automatic baggage propagation in browsers requires Zone.js from @opentelemetry/context-zone.
 *
 * @example
 * ```typescript
 * const client = new IntrospectionClient({
 *   token: "intro_xxx",
 *   debug: true,
 * });
 *
 * // Set identity once (persisted to localStorage)
 * client.identify("user_123", { email: "user@example.com" });
 *
 * // Simple feedback
 * client.feedback("thumbs_up", { comments: "Great response!" });
 *
 * // With explicit gen_ai context
 * client.feedback("thumbs_down", {
 *   conversationId: "conv_456",
 *   previousResponseId: "msg_123",
 *   comments: "Off topic",
 * });
 *
 * // With scoped baggage context
 * await client.withConversation("conv_456", undefined, async () => {
 *   client.feedback("thumbs_up"); // automatically includes conversation_id
 * });
 *
 * // Track a custom event
 * client.track("Button Clicked", { buttonId: "submit" });
 * ```
 */
export class IntrospectionClient {
  private loggerProvider: LoggerProvider;
  private otelLogger: ReturnType<LoggerProvider["getLogger"]>;
  private userId: string | undefined;
  private anonymousId: string;
  private traits: Record<string, unknown> = {};
  private logger: Logger;

  /**
   * @param options - Client configuration (token, service name, advanced settings).
   */
  constructor(options: IntrospectionClientOptions = {}) {
    const token = options.token || "";
    const advanced = options.advanced || {};
    const baseUrl =
      advanced.baseUrl ||
      (typeof process !== "undefined" && process.env?.INTROSPECTION_BASE_URL) ||
      "https://otel.introspection.dev";
    this.logger = new Logger(advanced.debug ?? false);

    // Load persisted state from localStorage
    this.anonymousId = this.loadAnonymousId();
    this.userId = this.loadUserId();
    this.traits = this.loadTraits();

    if (!token) {
      this.logger.warn("No token provided. Events will not be sent.");
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

    // Create OTLP log exporter with HTTP/JSON
    const exporter = new OTLPLogExporter({
      url: endpoint,
      headers,
    });

    // Create batch processor
    const processor = new BatchLogRecordProcessor(exporter, {
      maxQueueSize: advanced.maxBatchSize ?? 100,
      scheduledDelayMillis: advanced.flushInterval ?? 5000,
    });

    // Create logger provider with processor
    this.loggerProvider = new LoggerProvider({
      processors: [processor],
    });

    // Get a logger instance
    this.otelLogger = this.loggerProvider.getLogger(
      "@introspection-sdk/introspection-browser",
      VERSION,
    );

    // Flush on page unload
    if (typeof window !== "undefined") {
      window.addEventListener("beforeunload", () => {
        this.loggerProvider.forceFlush();
      });

      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "hidden") {
          this.loggerProvider.forceFlush();
        }
      });
    }

    this.logger.log(`Initialized with endpoint: ${endpoint}`);
  }

  /**
   * Load anonymous ID from localStorage, or generate a new one
   */
  private loadAnonymousId(): string {
    if (typeof localStorage !== "undefined") {
      const stored = localStorage.getItem(ANONYMOUS_ID_KEY);
      if (stored) {
        return stored;
      }
    }
    const newId = generateAnonymousId();
    this.persistAnonymousId(newId);
    return newId;
  }

  /**
   * Persist anonymous ID to localStorage
   */
  private persistAnonymousId(id: string): void {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(ANONYMOUS_ID_KEY, id);
    }
  }

  /**
   * Load user ID from localStorage
   */
  private loadUserId(): string | undefined {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem(USER_ID_KEY) || undefined;
    }
    return undefined;
  }

  /**
   * Persist user ID to localStorage
   */
  private persistUserId(id: string): void {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(USER_ID_KEY, id);
    }
  }

  /**
   * Load traits from localStorage
   */
  private loadTraits(): Record<string, unknown> {
    if (typeof localStorage !== "undefined") {
      const stored = localStorage.getItem(TRAITS_KEY);
      if (stored) {
        try {
          return JSON.parse(stored);
        } catch {
          return {};
        }
      }
    }
    return {};
  }

  /**
   * Persist traits to localStorage
   */
  private persistTraits(traits: Record<string, unknown>): void {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(TRAITS_KEY, JSON.stringify(traits));
    }
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
   * Uses performance.now() for high-resolution timing in browsers.
   */
  private getTimestamp(): [number, number] {
    const timeOrigin = performance.timeOrigin;
    const now = performance.now();
    const epochMs = timeOrigin + now;
    const seconds = Math.floor(epochMs / 1000);
    const nanos = Math.floor((epochMs % 1000) * 1_000_000);
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

    // Browser context
    if (typeof window !== "undefined") {
      attributes["context.page.path"] = window.location.pathname;
      attributes["context.page.url"] = window.location.href;
      attributes["context.page.title"] = document.title;
      attributes["context.page.referrer"] = document.referrer;
      attributes["context.page.search"] = window.location.search;
      attributes["context.userAgent"] = navigator.userAgent;
      attributes["context.locale"] = navigator.language;
      attributes["context.timezone"] =
        Intl.DateTimeFormat().resolvedOptions().timeZone;
      attributes["context.screen.width"] = window.screen.width;
      attributes["context.screen.height"] = window.screen.height;
      attributes["context.screen.density"] = window.devicePixelRatio;
    }

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

    this.logger.log(`Tracked: ${eventName}`);
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

    this.logger.log(`Feedback: ${name}`);
  }

  /**
   * Identify a user and persist their traits to `localStorage`.
   *
   * @param userId - The user's unique identifier.
   * @param traits - Optional user traits (email, name, plan, etc.).
   * @param anonymousId - Optional anonymous ID to associate.
   * @param eventId - Optional event ID (auto-generated if omitted).
   *
   * @example
   * ```ts
   * client.identify("user-123", { email: "user@example.com", plan: "pro" });
   * ```
   */
  identify(
    userId: string,
    traits?: UserTraits,
    anonymousId?: string,
    eventId?: string,
  ): void {
    // Store and persist
    this.userId = userId;
    this.persistUserId(userId);
    if (anonymousId) {
      this.anonymousId = anonymousId;
      this.persistAnonymousId(anonymousId);
    }
    if (traits) {
      this.traits = { ...this.traits, ...traits };
      this.persistTraits(this.traits);
    }

    const attributes = this.buildAttributes("identify", { traits, eventId });

    this.otelLogger.emit({
      timestamp: this.getTimestamp(),
      context: context.active(),
      severityNumber: SeverityNumber.INFO,
      severityText: "INFO",
      attributes,
    });

    this.logger.log(`Identified: ${userId}`);
  }

  /**
   * Set the authenticated user ID and persist it to `localStorage`.
   *
   * @param userId - The user's unique identifier.
   *
   * @example
   * ```ts
   * client.setUserId("user-123");
   * ```
   */
  setUserId(userId: string): void {
    this.userId = userId;
    this.persistUserId(userId);
  }

  /**
   * Override the anonymous ID and persist it to `localStorage`.
   *
   * @param anonymousId - The anonymous visitor identifier.
   *
   * @example
   * ```ts
   * client.setAnonymousId("anon-abc");
   * ```
   */
  setAnonymousId(anonymousId: string): void {
    this.anonymousId = anonymousId;
    this.persistAnonymousId(anonymousId);
  }

  /**
   * Get the current anonymous visitor identifier.
   *
   * @returns The anonymous ID (auto-generated on first access if not set).
   *
   * @example
   * ```ts
   * const anonId = client.getAnonymousId();
   * ```
   */
  getAnonymousId(): string {
    return this.anonymousId;
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
  createBaggageContext(values: Record<string, string>) {
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
    const values: Record<string, string> = {
      "gen_ai.agent.name": agentName,
    };
    if (agentId) {
      values["gen_ai.agent.id"] = agentId;
    }
    const ctx = this.createBaggageContext(values);
    return await context.with(ctx, callback);
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
   *
   * // Just previousResponseId when already in a conversation
   * await client.withConversation("conv_456", undefined, async () => {
   *   await client.withConversation(undefined, "resp_1", async () => {
   *     client.feedback("thumbs_up");
   *   });
   * });
   * ```
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
    const ctx = this.createBaggageContext(values);
    return await context.with(ctx, callback);
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
    const ctx = this.createBaggageContext({
      "identity.user_id": userId,
    });
    return await context.with(ctx, callback);
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
    const ctx = this.createBaggageContext({
      "identity.anonymous_id": anonymousId,
    });
    return await context.with(ctx, callback);
  }

  /**
   * Reset the client state, clearing user identity and generating a new
   * anonymous ID. Equivalent to a logout operation.
   *
   * @example
   * ```ts
   * client.reset();
   * ```
   */
  reset(): void {
    this.userId = undefined;
    this.anonymousId = generateAnonymousId();
    this.traits = {};

    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(USER_ID_KEY);
      localStorage.removeItem(TRAITS_KEY);
      localStorage.setItem(ANONYMOUS_ID_KEY, this.anonymousId);
    }

    this.logger.log("Reset complete");
  }

  /**
   * Flush all queued log records to the Introspection backend.
   *
   * @returns A promise that resolves once the flush completes.
   */
  async flush(): Promise<void> {
    await this.loggerProvider.forceFlush();
    this.logger.log("Flushed pending log records");
  }

  /**
   * Shut down the client, flushing all pending log records.
   *
   * @returns A promise that resolves once shutdown is complete.
   */
  async shutdown(): Promise<void> {
    await this.loggerProvider.shutdown();
    this.logger.log("Shutdown complete");
  }
}
