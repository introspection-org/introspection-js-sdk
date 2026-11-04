/**
 * Introspection Client for Browser
 * Provides an API for tracking events and feedback using OTLP Logs.
 *
 * Identity and gen_ai context can be managed via baggage (requires OpenTelemetry
 * browser SDK with Zone.js for automatic propagation) or via client instance.
 */

import type { LogAttributes } from "@opentelemetry/api-logs";
import {
  LoggerProvider,
  BatchLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-http";
import {
  LogEventClient,
  activeBaggageValue,
  logBatchConfig,
  logsEndpoint,
} from "@introspection-sdk/types/logs";
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { VERSION } from "./version.js";
import {
  type IntrospectionClientOptions,
  type UserTraits,
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
 *
 * // Log an app event under your own namespace
 * client.logEvent("checkout.completed", { orderId: "o_1" });
 * ```
 */
/**
 * Attach the page-hide flush listeners and return a function that removes
 * them again.
 */
function attachFlushListeners(flush: () => void): () => void {
  const onUnload = () => flush();
  const onVisibility = () => {
    if (document.visibilityState === "hidden") flush();
  };
  window.addEventListener("beforeunload", onUnload);
  document.addEventListener("visibilitychange", onVisibility);
  return () => {
    window.removeEventListener("beforeunload", onUnload);
    document.removeEventListener("visibilitychange", onVisibility);
  };
}

export class IntrospectionClient extends LogEventClient {
  private loggerProvider: LoggerProvider;
  protected otelLogger: ReturnType<LoggerProvider["getLogger"]>;
  /** Removes the page-unload flush listeners; set only in a browser. */
  private detachFlushListeners?: () => void;
  private userId: string | undefined;
  private anonymousId: string;
  private traits: Record<string, unknown> = {};
  private logger: Logger;

  /**
   * @param options - Client configuration (token, service name, advanced settings).
   */
  constructor(options: IntrospectionClientOptions = {}) {
    super();
    const token = options.token || "";
    const advanced = options.advanced || {};
    const baseUrl =
      advanced.baseUrl ||
      (typeof process !== "undefined" &&
        process.env?.INTROSPECTION_BASE_OTEL_URL) ||
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
    const endpoint = logsEndpoint(baseUrl);

    // Build headers
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (advanced.additionalHeaders) {
      Object.assign(headers, advanced.additionalHeaders);
    }

    // Create OTLP log exporter with HTTP/JSON. `advanced.logExporter` swaps
    // it for an in-memory one: the analytics stream is the whole point of
    // this client, and without a seam there was no way to assert what it
    // puts on the wire short of standing up a collector.
    const exporter =
      advanced.logExporter ??
      new OTLPLogExporter({
        url: endpoint,
        headers,
      });

    // Create batch processor
    const processor = new BatchLogRecordProcessor({
      exporter,
      ...logBatchConfig(advanced),
    });

    // Merge onto the default resource rather than replacing it: the default
    // is what supplies `telemetry.sdk.language` ("webjs") and the SDK
    // version, which is how a record is attributed to this surface, since
    // the scope name alone does not name a platform. Passing no resource at
    // all left `service.name` at `unknown_service` -- the `serviceName`
    // option was accepted and never applied.
    this.loggerProvider = new LoggerProvider({
      resource: defaultResource().merge(
        resourceFromAttributes({
          [ATTR_SERVICE_NAME]:
            options.serviceName ?? "introspection-browser-client",
        }),
      ),
      processors: [processor],
    });

    // Get a logger instance
    // The dist name, per the OTel convention that the scope names the
    // instrumentation library. Deliberately not platform-tagged: the SDK
    // language already rides the resource as `telemetry.sdk.language`, which
    // is the semconv-designated place for it.
    this.otelLogger = this.loggerProvider.getLogger(
      "introspection-sdk",
      VERSION,
    );

    // Flush on page unload. Kept as named handlers so `shutdown()` can
    // remove them: left attached, they call `forceFlush()` on a dead
    // provider at the next page-hide, and pin the client for the page's
    // lifetime -- an SPA that recreates the client accumulates a pair per
    // instance.
    if (typeof window !== "undefined") {
      this.detachFlushListeners = attachFlushListeners(() => {
        void this.loggerProvider.forceFlush();
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

  /** Get identity from baggage or client instance */
  protected getIdentityFromContext(): IdentityContext {
    return {
      userId: activeBaggageValue("identity.user_id") || this.userId,
      anonymousId:
        activeBaggageValue("identity.anonymous_id") || this.anonymousId,
    };
  }

  /**
   * Get current timestamp as OpenTelemetry HrTime.
   * Uses performance.now() for high-resolution timing in browsers.
   */
  protected getTimestamp(): [number, number] {
    const timeOrigin = performance.timeOrigin;
    const now = performance.now();
    const epochMs = timeOrigin + now;
    const seconds = Math.floor(epochMs / 1000);
    const nanos = Math.floor((epochMs % 1000) * 1_000_000);
    return [seconds, nanos];
  }

  protected debugLog(message: string): void {
    this.logger.log(message);
  }

  /** Browser page, locale and screen context. */
  protected platformAttributes(): LogAttributes | undefined {
    if (typeof window === "undefined") return undefined;
    return {
      "context.page.path": window.location.pathname,
      "context.page.url": window.location.href,
      "context.page.title": document.title,
      "context.page.referrer": document.referrer,
      "context.page.search": window.location.search,
      "context.userAgent": navigator.userAgent,
      "context.locale": navigator.language,
      "context.timezone": Intl.DateTimeFormat().resolvedOptions().timeZone,
      "context.screen.width": window.screen.width,
      "context.screen.height": window.screen.height,
      "context.screen.density": window.devicePixelRatio,
    };
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

    this.emit(this.buildAttributes("identify", { traits, eventId }));

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
   * Get the identified user, if {@link identify} or {@link setUserId} has
   * been called (in this session or a previous one — it is persisted).
   *
   * @returns The user ID, or `undefined` while the visitor is anonymous.
   *
   * @example
   * ```ts
   * const userId = client.getUserId();
   * ```
   */
  getUserId(): string | undefined {
    return this.userId;
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
    this.detachFlushListeners?.();
    this.detachFlushListeners = undefined;
    await this.loggerProvider.shutdown();
    this.logger.log("Shutdown complete");
  }
}
