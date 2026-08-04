/**
 * OTLP exporter wiring for the hook process.
 *
 * A hook is a short-lived process that runs while the user waits, which inverts
 * the usual tracing setup:
 *
 * - **`SimpleSpanProcessor`, not `BatchSpanProcessor`.** Batching exists to
 *   amortize export across a long-lived process. Here the process exits moments
 *   after the spans are created, so a batch would just be flushed immediately
 *   anyway — with an extra scheduling delay bolted on.
 * - **No global registration.** This provider is created, used, and shut down
 *   locally. Registering it globally would be pointless in a process this short
 *   and actively harmful if the package is ever imported into a host that has
 *   its own tracing set up.
 */
import {
  BasicTracerProvider,
  SimpleSpanProcessor,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import { HttpsProxyAgent } from "https-proxy-agent";
import { getProxyForUrl } from "proxy-from-env";
import type { Attributes } from "@opentelemetry/api";

import { VERSION } from "./version.js";

/** A provider plus the tracer to emit on. */
export interface CaptureTracing {
  provider: BasicTracerProvider;
  tracer: ReturnType<BasicTracerProvider["getTracer"]>;
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
          "User-Agent": `introspection-sdk/${VERSION}`,
          Authorization: `Bearer ${token}`,
        },
        // Bounded so a hung collector cannot hold a hook open. The caller
        // enforces its own outer deadline too; this is the transport-level one.
        timeoutMillis: 10_000,
      }),
    );

  const provider = new BasicTracerProvider({
    resource: defaultResource().merge(resourceFromAttributes(resourceAttrs)),
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  return {
    provider,
    tracer: provider.getTracer("introspection-plugin", VERSION),
  };
}
