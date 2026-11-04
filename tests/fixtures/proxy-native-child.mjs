// Runs in a fresh Node process: NODE_EXTRA_CA_CERTS is read only at startup.
import { register } from "node:module";
import process from "node:process";

// Resolve the proxy package's `./x.js` specifiers to its `.ts` sources.
register(
  "data:text/javascript," +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (err) {
    if (specifier.endsWith(".js") && context.parentURL?.endsWith(".ts")) {
      return next(specifier.slice(0, -3) + ".ts", context);
    }
    throw err;
  }
}`),
);

const { context, propagation, trace } = await import("@opentelemetry/api");
const { AsyncLocalStorageContextManager } =
  await import("@opentelemetry/context-async-hooks");
const { W3CTraceContextPropagator } = await import("@opentelemetry/core");
const { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } =
  await import("@opentelemetry/sdk-trace-base");
const { createProxyFetch } =
  await import("../../packages/introspection-proxy/src/index.ts");

const exporter = new InMemorySpanExporter();
trace.setGlobalTracerProvider(
  new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  }),
);
context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

const response = await createProxyFetch()(process.argv[2]);
const body = await response.text();

process.stdout.write(
  JSON.stringify({
    status: response.status,
    body,
    spans: exporter.getFinishedSpans().map((span) => ({
      name: span.name,
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      attributes: span.attributes,
    })),
  }),
);
