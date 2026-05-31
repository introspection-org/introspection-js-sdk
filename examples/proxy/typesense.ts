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
 * Run with:
 *   EGRESS_PROXY_URL=http://localhost:10000
 *   TYPESENSE_HOST=<cluster>.a1.typesense.net
 *   TYPESENSE_API_KEY=<key or placeholder; injected by the egress proxy>
 *   pnpm proxy-typesense
 */
import Typesense from "typesense";
import { installProxyFetch } from "@introspection-sdk/introspection-proxy";

const TYPESENSE_HOST = process.env.TYPESENSE_HOST;
const TYPESENSE_API_KEY = process.env.TYPESENSE_API_KEY;

if (!TYPESENSE_HOST || !TYPESENSE_API_KEY) {
  console.error(
    "Set TYPESENSE_HOST and TYPESENSE_API_KEY (and EGRESS_PROXY_URL to route via the egress proxy).",
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
    // axios can't take a per-client fetch, so we point it at the global fetch
    // adapter — which installProxyFetch() has routed through the egress proxy.
    axiosAdapter: "fetch",
  });

  const health = await client.health.retrieve();
  console.log("Typesense health:", health);

  const collections = await client.collections().retrieve();
  console.log(`Found ${collections.length} collection(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
