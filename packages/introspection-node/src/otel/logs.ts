/**
 * IntrospectionLogs — OTel logs exporter for Introspection.
 *
 * Owns its own `LoggerProvider` and OTLP log exporter. Provides `logEvent`,
 * `track`, `feedback`, `identify`, and async-context helpers (`withBaggage`,
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

import {
  LoggerProvider,
  BatchLogRecordProcessor,
  type LogRecordExporter,
} from "@opentelemetry/sdk-logs";
import { OTLPLogExporter } from "@opentelemetry/exporter-logs-otlp-proto";
import {
  resourceFromAttributes,
  defaultResource,
} from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { context } from "@opentelemetry/api";
import {
  LogEventClient,
  activeBaggageValue,
  logBatchConfig,
  logsEndpoint,
} from "@introspection-sdk/types/logs";

import {
  DEFAULT_SERVICE_NAME,
  exporterHeaders,
  logger as sdkLogger,
  otlpUserAgent,
  withOtlpHttpsProxy,
} from "../utils.js";
import { VERSION } from "../version.js";
import { type UserTraits, type IdentityContext } from "../types.js";

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
  /** Additional HTTP headers to include in exporter requests. */
  additionalHeaders?: Record<string, string>;
  /** Flush interval in milliseconds (default: 5000). */
  flushInterval?: number;
  /** Maximum export batch size (default: 100). */
  maxBatchSize?: number;
  /**
   * Maximum records buffered before new ones are dropped. Omit to keep the
   * OTel SDK's default. See {@link AdvancedOptions.maxQueueSize}.
   */
  maxQueueSize?: number;
  /**
   * How long one export may take before it is abandoned, in milliseconds.
   * Omit to keep the OTel SDK's default.
   */
  exportTimeoutMillis?: number;
  /**
   * Custom log record exporter, bypassing OTLP construction.
   *
   * The analytics stream is the contract that has to match across SDKs, and
   * this is the seam for asserting what goes out on it. Matches the Python
   * SDK's `log_exporter` constructor argument, the Rust config's
   * `log_exporter`, and the browser client's `advanced.logExporter`.
   */
  logExporter?: LogRecordExporter;
}

export class IntrospectionLogs extends LogEventClient {
  private loggerProvider: LoggerProvider;
  protected otelLogger: ReturnType<LoggerProvider["getLogger"]>;

  constructor(options: IntrospectionLogsOptions = {}) {
    super();
    const token = options.token || process.env.INTROSPECTION_TOKEN || "";
    const serviceName =
      options.serviceName ||
      process.env.INTROSPECTION_SERVICE_NAME ||
      DEFAULT_SERVICE_NAME;
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
    const endpoint = logsEndpoint(baseOtelUrl);

    const headers = exporterHeaders(token, options.additionalHeaders);

    const exporter =
      options.logExporter ??
      new OTLPLogExporter(
        withOtlpHttpsProxy({
          url: endpoint,
          headers,
          ...otlpUserAgent,
        }),
      );

    const processor = new BatchLogRecordProcessor({
      exporter,
      ...logBatchConfig(options),
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

    // The dist name, per the OTel convention that the scope names the
    // instrumentation library. Deliberately not platform-tagged: the SDK
    // language already rides the resource as `telemetry.sdk.language`, which
    // is the semconv-designated place for it.
    this.otelLogger = this.loggerProvider.getLogger(
      "introspection-sdk",
      VERSION,
    );

    sdkLogger.info(
      `IntrospectionLogs initialized: service=${serviceName}, otlp=${endpoint}`,
    );
  }

  /**
   * Get identity from baggage.
   *
   * Baggage only, deliberately. This used to fall back to `userId` /
   * `anonymousId` held on the instance, but `init()` builds one instance per
   * process: under any concurrency, the identity of whichever request called
   * `identify()` last attached itself to every other request's events. Scope
   * identity with {@link withUserId} / {@link withAnonymousId} instead, which
   * carry it on the async context where it belongs.
   */
  protected getIdentityFromContext(): IdentityContext {
    return {
      userId: activeBaggageValue("identity.user_id"),
      anonymousId: activeBaggageValue("identity.anonymous_id"),
    };
  }

  protected getTimestamp(): [number, number] {
    // Wall-clock only. An earlier version subtracted one `process.hrtime`
    // reading from another taken microseconds later, which looked like an
    // hrtime/epoch correlation but only ever removed the elapsed call time.
    const epochNs = BigInt(Date.now()) * BigInt(1_000_000);
    const seconds = Number(epochNs / BigInt(1_000_000_000));
    const nanos = Number(epochNs % BigInt(1_000_000_000));
    return [seconds, nanos];
  }

  protected debugLog(message: string): void {
    sdkLogger.debug(message);
  }

  /**
   * Emit an `identify` event associating `userId` with `traits`.
   *
   * The identity lands on this event only. It does not persist onto later
   * `track` / `feedback` calls — wrap those in {@link withUserId} (or set the
   * baggage yourself) to scope identity across several events.
   */
  identify(
    userId: string,
    traits?: UserTraits,
    anonymousId?: string,
    eventId?: string,
  ): void {
    const identity: Record<string, string> = { "identity.user_id": userId };
    if (anonymousId) identity["identity.anonymous_id"] = anonymousId;

    // The ids are passed straight through rather than round-tripped via
    // baggage. Reading them back off the context made the identify event
    // depend on a globally registered context manager: `init()` registers
    // one, but a standalone `new IntrospectionLogs()` -- the form the README
    // shows -- gets the API's no-op manager, where `context.with()` runs the
    // callback and `context.active()` still returns ROOT. The event then went
    // out with no identity on it at all, silently.
    //
    // The scope is still entered, so anything the emit touches (a span, a
    // downstream propagator) sees the same identity when a real manager is
    // installed.
    context.with(this.createBaggageContext(identity), () => {
      this.emit(
        this.buildAttributes("identify", {
          traits,
          eventId,
          identity: { userId, anonymousId },
        }),
      );
    });
    sdkLogger.debug(`Identified: ${userId}`);
  }

  /** The user id on the current async context, if one is scoped. */
  getUserId(): string | undefined {
    return this.getIdentityFromContext().userId;
  }

  /** The anonymous id on the current async context, if one is scoped. */
  getAnonymousId(): string | undefined {
    return this.getIdentityFromContext().anonymousId;
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
