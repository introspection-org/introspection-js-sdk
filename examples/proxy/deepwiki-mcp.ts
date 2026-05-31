/**
 * DeepWiki MCP through the Introspection egress (reverse) proxy.
 *
 * DeepWiki (https://docs.devin.ai/work-with-devin/deepwiki-mcp) exposes a
 * public, no-auth remote MCP server over Streamable HTTP. We connect with the
 * official MCP TypeScript SDK (`@modelcontextprotocol/sdk`) and hand its
 * `StreamableHTTPClientTransport` a proxy-aware `fetch` from
 * `createProxyFetch()`, so every MCP request is routed through the egress
 * proxy. (DeepWiki needs no credential, so this demonstrates routing; for an
 * authenticated MCP server the egress proxy would inject the token.)
 *
 * It then asks DeepWiki about this very SDK — which frameworks it supports for
 * OpenTelemetry trace instrumentation.
 *
 * Run with:
 *   EGRESS_PROXY_URL=http://localhost:10000
 *   pnpm proxy-deepwiki
 *
 * Optional:
 *   DEEPWIKI_MCP_URL   (default https://mcp.deepwiki.com/mcp)
 *   DEEPWIKI_REPO      (default introspection-org/introspection-js-sdk)
 *   DEEPWIKI_QUESTION  (default asks about supported OTel instrumentation)
 *
 * Note: DeepWiki indexes *public* GitHub repos. If DEEPWIKI_REPO isn't indexed,
 * point it at a public repo (e.g. modelcontextprotocol/typescript-sdk).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createProxyFetch } from "@introspection-sdk/introspection-proxy";

const MCP_URL = process.env.DEEPWIKI_MCP_URL ?? "https://mcp.deepwiki.com/mcp";
const REPO =
  process.env.DEEPWIKI_REPO ?? "introspection-org/introspection-js-sdk";
const QUESTION =
  process.env.DEEPWIKI_QUESTION ??
  "Which frameworks are supported for OpenTelemetry trace instrumentation?";

async function main() {
  const egress = process.env.EGRESS_PROXY_URL;
  console.log(
    egress
      ? `Routing DeepWiki MCP through egress proxy: ${egress}`
      : "EGRESS_PROXY_URL unset — talking to DeepWiki directly.",
  );

  // Route MCP HTTP through the proxy by giving the transport a proxy-aware
  // fetch. (Alternatively call installProxyFetch() once and omit `fetch`.)
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: createProxyFetch(),
  });

  const client = new Client({
    name: "introspection-proxy-example",
    version: "0.1.0",
  });
  await client.connect(transport);

  const { tools } = await client.listTools();
  console.log(`DeepWiki tools: ${tools.map((t) => t.name).join(", ")}`);

  console.log(`\nAsking DeepWiki about ${REPO}:\n  "${QUESTION}"\n`);
  const result = await client.callTool({
    name: "ask_question",
    arguments: { repoName: REPO, question: QUESTION },
  });

  const content = result.content as Array<{ type: string; text?: string }>;
  const answer = content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  console.log(answer || JSON.stringify(result, null, 2));

  await client.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
