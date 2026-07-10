/**
 * DeepWiki MCP via mcporter, through the Introspection proxy — with
 * `introspection-proxy-call` spans.
 *
 * Companion to `deepwiki-mcp.ts` (which wires the official MCP SDK client by
 * hand). Here the MCP client is mcporter (https://github.com/openclaw/mcporter),
 * a third-party runtime we cannot pass a fetch into per-call — but we don't
 * need to: mcporter's Streamable HTTP transport uses the *global* fetch by
 * default, so a single `installProxyFetch()` before the runtime is created
 * routes every mcporter request through the egress/forward proxy. This is the
 * same injection the Introspection sandbox performs process-wide via its
 * `NODE_OPTIONS` preload, which is how the sandbox `mcp` CLI (mcporter-backed)
 * picks the proxy up without any code change.
 *
 * Each proxied request emits an `introspection-proxy-call` CLIENT span
 * (method, host, query-stripped URL, proxy mode, status). Spans no-op without
 * a tracer provider, so this example registers one: the
 * `IntrospectionSpanProcessor` when INTROSPECTION_TOKEN is set, else a console
 * exporter so the spans are visible locally. Requests that go direct (no
 * proxy configured, or a NO_PROXY host) intentionally emit no proxy span.
 *
 * Run with:
 *   INTROSPECTION_EGRESS_URL=http://localhost:10000   # egress mode, or
 *   HTTPS_PROXY=http://localhost:3128                 # forward mode
 *   pnpm proxy-deepwiki-mcporter
 *
 * Optional:
 *   INTROSPECTION_TOKEN  (export spans to Introspection instead of the console)
 *   DEEPWIKI_MCP_URL     (default https://mcp.deepwiki.com/mcp)
 *   DEEPWIKI_REPO        (default introspection-org/introspection-js-sdk)
 *   DEEPWIKI_QUESTION    (default asks about supported OTel instrumentation)
 */
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createCallResult, createRuntime } from "mcporter";
import { installProxyFetch } from "@introspection-sdk/introspection-proxy";
import { IntrospectionSpanProcessor } from "@introspection-sdk/introspection-node/otel";

const MCP_URL = process.env.DEEPWIKI_MCP_URL ?? "https://mcp.deepwiki.com/mcp";
const REPO =
  process.env.DEEPWIKI_REPO ?? "introspection-org/introspection-js-sdk";
const QUESTION =
  process.env.DEEPWIKI_QUESTION ??
  "Which frameworks are supported for OpenTelemetry trace instrumentation?";

function initTracing(): BasicTracerProvider {
  const token = process.env.INTROSPECTION_TOKEN;
  const spanProcessors: SpanProcessor[] = [
    token
      ? new IntrospectionSpanProcessor({ token })
      : new SimpleSpanProcessor(new ConsoleSpanExporter()),
  ];
  const provider = new BasicTracerProvider({ spanProcessors });
  trace.setGlobalTracerProvider(provider);
  console.log(
    token
      ? "Exporting introspection-proxy-call spans to Introspection."
      : "No INTROSPECTION_TOKEN — printing introspection-proxy-call spans to the console.",
  );
  return provider;
}

async function main() {
  const provider = initTracing();

  const egress = process.env.INTROSPECTION_EGRESS_URL;
  const forward = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  console.log(
    egress
      ? `Routing DeepWiki MCP through egress proxy: ${egress}`
      : forward
        ? `Routing DeepWiki MCP through forward proxy: ${forward}`
        : "No proxy configured — direct requests emit no proxy span.",
  );

  // One line, before the runtime exists: mcporter's HTTP transport uses the
  // global fetch, so every MCP request now routes through the proxy and emits
  // an introspection-proxy-call span.
  installProxyFetch();

  const runtime = await createRuntime({
    servers: [
      {
        name: "deepwiki",
        command: { kind: "http", url: new URL(MCP_URL) },
      },
    ],
  });

  try {
    const tools = await runtime.listTools("deepwiki");
    console.log(`DeepWiki tools: ${tools.map((t) => t.name).join(", ")}`);

    console.log(`\nAsking DeepWiki about ${REPO}:\n  "${QUESTION}"\n`);
    const result = await runtime.callTool("deepwiki", "ask_question", {
      args: { repoName: REPO, question: QUESTION },
    });

    const answer = createCallResult(result).text();
    console.log(answer ?? JSON.stringify(result, null, 2));
  } finally {
    await runtime.close();
    await provider.forceFlush();
    await provider.shutdown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
