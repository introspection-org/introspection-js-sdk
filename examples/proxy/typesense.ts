/**
 * Typesense through the Introspection egress (reverse) proxy.
 *
 * Unlike supabase-js (which exposes a per-client `global.fetch` option), the
 * Typesense client uses axios — and axios does NOT let you set a custom `fetch`
 * per client: its built-in `fetch` adapter always uses the process-global
 * fetch. So we install a process-wide proxy-aware fetch via `installProxyFetch()`
 * and point Typesense's axios at the fetch adapter with `axiosAdapter: "fetch"`.
 * With `EGRESS_PROXY_URL` set, Typesense traffic is routed to the egress proxy,
 * which routes by `Host` and injects the real `X-TYPESENSE-API-KEY` — so this
 * process can use a placeholder key.
 *
 * Note: there is no clean per-client equivalent of supabase's `global.fetch`
 * here. The only alternatives (a Host-header trick, or a hand-written axios
 * adapter) aren't worth the cost, so the process-wide swap is the recommended
 * pattern for axios-based clients.
 *
 * This example runs a no-key `/health` check (which proves routing on its own)
 * and a document `search` — which works with a **search-only** key. Listing
 * collections would instead require an **admin** key.
 *
 * Run with:
 *   EGRESS_PROXY_URL=http://localhost:10000
 *   TYPESENSE_HOST=<cluster>.a1.typesense.net
 *   TYPESENSE_SEARCH_API_KEY=<search-only key>   # (or TYPESENSE_API_KEY)
 *   TYPESENSE_COLLECTION=todos                   # optional, default "todos"
 *   TYPESENSE_QUERY_BY=title                     # field to search IN; default "title"
 *   TYPESENSE_QUERY=<search term>                # optional, default "*" (all)
 *   pnpm proxy-typesense
 */
import Typesense from "typesense";
import { installProxyFetch } from "@introspection-sdk/introspection-proxy";

const TYPESENSE_HOST = process.env.TYPESENSE_HOST;
const TYPESENSE_API_KEY =
  process.env.TYPESENSE_SEARCH_API_KEY ?? process.env.TYPESENSE_API_KEY;
const COLLECTION = process.env.TYPESENSE_COLLECTION ?? "todos";
const QUERY_BY = process.env.TYPESENSE_QUERY_BY ?? "title";
const QUERY = process.env.TYPESENSE_QUERY ?? "*";

if (!TYPESENSE_HOST || !TYPESENSE_API_KEY) {
  console.error(
    "Set TYPESENSE_HOST and TYPESENSE_SEARCH_API_KEY (and EGRESS_PROXY_URL to route via the egress proxy).",
  );
  process.exit(1);
}

async function main() {
  const egress = process.env.EGRESS_PROXY_URL;
  console.log(
    egress
      ? `Routing ALL fetch (incl. Typesense) through egress proxy: ${egress}`
      : "EGRESS_PROXY_URL unset — talking to Typesense directly.",
  );

  // Route every fetch in this process through the egress proxy. No-op when
  // EGRESS_PROXY_URL is unset. Call once, before constructing the client.
  installProxyFetch();

  const client = new Typesense.Client({
    nodes: [{ host: TYPESENSE_HOST!, port: 443, protocol: "https" }],
    apiKey: TYPESENSE_API_KEY!,
    connectionTimeoutSeconds: 10,
    // Make Typesense's axios use the global fetch, which installProxyFetch()
    // has pointed at the egress proxy.
    axiosAdapter: "fetch",
  });

  // /health needs no key — confirms connectivity (and routing) on its own.
  const health = await client.health.retrieve();
  console.log("Typesense health:", health);

  // A search works with a search-only key (unlike listing collections, which
  // needs an admin key). Set TYPESENSE_QUERY_BY to a text field in your schema.
  console.log(`Searching "${COLLECTION}" for "${QUERY}" by "${QUERY_BY}"...`);
  const results = (await client
    .collections(COLLECTION)
    .documents()
    .search({ q: QUERY, query_by: QUERY_BY, per_page: 5 })) as {
    found: number;
    hits?: Array<{ document: Record<string, unknown> }>;
  };
  console.log(
    `Found ${results.found} hit(s); first ${results.hits?.length ?? 0} returned.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
