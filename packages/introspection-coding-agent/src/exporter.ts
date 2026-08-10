/**
 * OTLP exporter wiring for the hook process.
 *
 * A hook is a short-lived process that runs while the user waits:
 *
 * - **`BatchSpanProcessor`, not `SimpleSpanProcessor`.** `SimpleSpanProcessor`
 *   exports **one HTTP request per span** — it is "simple" in the sense of no
 *   buffering, not "flush once at the end". A single captured turn routinely
 *   produces hundreds of spans, and a real run against a collector produced 293
 *   separate POSTs and then failed with `Concurrent export limit reached`. The
 *   batch processor coalesces them and `shutdown()` flushes what is queued, so
 *   the whole turn leaves in a handful of requests.
 * - **A generous queue.** The batch processor silently drops spans once its
 *   queue is full, and a silent drop is worse here than anywhere else: the
 *   checkpoint would advance over spans that never existed. The queue is sized
 *   far above any plausible single turn rather than tuned tight.
 * - **No global registration.** This provider is created, used, and shut down
 *   locally. Registering it globally would be pointless in a process this short
 *   and actively harmful if the package is ever imported into a host that has
 *   its own tracing set up.
 */
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";
import type { Attributes } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

import { VERSION } from "./version.js";

/**
 * Wraps an exporter so a failed export is observable.
 *
 * OTel span processors hand export errors to the SDK's `globalErrorHandler`
 * and drops them; `provider.shutdown()` then resolves whether or not anything
 * actually reached the collector. That is reasonable for a long-lived service —
 * telemetry should never take the process down — but it silently breaks the one
 * guarantee this package makes: that the transcript checkpoint advances only
 * after spans are safely delivered. Without this wrapper a dead collector looks
 * exactly like a successful export, and the turn is skipped forever.
 *
 * So the result code is intercepted on the way through, and the first failure is
 * kept for the caller to check before it commits a checkpoint.
 */
class ResultTrackingExporter implements SpanExporter {
  private _failure: Error | undefined;

  constructor(private readonly inner: SpanExporter) {}

  /** The first export failure seen, if any. */
  get failure(): Error | undefined {
    return this._failure;
  }

  export(
    spans: ReadableSpan[],
    resultCallback: (result: ExportResult) => void,
  ): void {
    this.inner.export(spans, (result) => {
      if (result.code !== ExportResultCode.SUCCESS) {
        this._failure ??= result.error ?? new Error("span export failed");
      }
      resultCallback(result);
    });
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

/** A provider plus the tracer to emit on. */
export interface CaptureTracing {
  provider: BasicTracerProvider;
  tracer: ReturnType<BasicTracerProvider["getTracer"]>;
  /**
   * The first export failure, readable after `provider.shutdown()`. `undefined`
   * means every span was accepted — the only state in which a caller may advance
   * its checkpoint.
   */
  exportFailure(): Error | undefined;
}

/**
 * Attach a forward-proxy agent when one is configured for the endpoint.
 *
 * Mirrors `@introspection-sdk/introspection-node`'s `withOtlpHttpsProxy`: the
 * OTLP proto exporter uses Node's `https` stack, so this needs an `http.Agent`,
 * and `getProxyForUrl` is what honours `NO_PROXY` (which `HttpsProxyAgent`
 * ignores on its own). Developer machines behind a corporate proxy are common
 * enough that omitting this would silently disable capture for them.
 */
function withProxy<T extends { url?: string }>(options: T): T {
  const proxyUrl = options.url ? getProxyForUrl(options.url) : "";
  if (!proxyUrl) return options;
  return {
    ...options,
    httpAgentOptions: () => new HttpsProxyAgent(proxyUrl),
  } as T;
}

/**
 * Build a tracer provider that exports to `endpoint` as `token`.
 *
 * The token is the CLI login's project-scoped access token. Tenancy is *not*
 * passed as attributes: the processor stamps `org_id` / `project_id` /
 * `member_id` onto every record from the bearer's own claims, and a span
 * attribute claiming a tenant would be both redundant and untrusted.
 */
export function createTracing(
  endpoint: string,
  token: string,
  resourceAttrs: Attributes,
  exporterOverride?: SpanExporter,
): CaptureTracing {
  const exporter =
    exporterOverride ??
    new OTLPTraceExporter(
      withProxy({
        url: endpoint,
        headers: {
          Authorization: `Bearer ${token}`,
        },
        // Not a `User-Agent` header: the OTLP HTTP transport overwrites that
        // one unconditionally just before the request, so it never reaches
        // the collector. This option is prepended to the exporter's own.
        userAgent: `introspection-sdk/${VERSION}`,
        // Bounded so a hung collector cannot hold a hook open. The caller
        // enforces its own outer deadline too; this is the transport-level one.
        timeoutMillis: 10_000,
      }),
    );

  // Wrap even an injected exporter, so a test double that reports failure is
  // treated exactly like a real collector rejecting the batch.
  const tracked = new ResultTrackingExporter(exporter);

  const provider = new BasicTracerProvider({
    resource: defaultResource().merge(resourceFromAttributes(resourceAttrs)),
    spanProcessors: [
      new BatchSpanProcessor(tracked, {
        // Sized for the worst realistic first capture of a long session, not
        // for steady state — an overflow drop would silently lose spans the
        // checkpoint is about to advance past.
        maxQueueSize: 16_384,
        maxExportBatchSize: 512,
        // The process exits right after `shutdown()`, which flushes. The timer
        // is only a backstop, so it is set long enough not to fire mid-run.
        scheduledDelayMillis: 30_000,
        exportTimeoutMillis: 10_000,
      }),
    ],
  });

  return {
    provider,
    tracer: provider.getTracer("introspection-plugin", VERSION),
    exportFailure: () => tracked.failure,
  };
}
