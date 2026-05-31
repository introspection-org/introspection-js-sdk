/**
 * Typesense through the Introspection egress (reverse) proxy.
 *
 * Unlike supabase-js, the Typesense client uses **axios**, not `fetch`, so it
 * won't pick up a custom fetch on its own. We bridge it onto `fetch` with
 * Typesense's `axiosAdapter: "fetch"` and then install a process-wide
 * proxy-aware fetch via `installProxyFetch()`. With `EGRESS_PROXY_URL` set,
 * Typesense traffic is routed to the egress proxy, which routes by `Host` and
 * injects the real `X-TYPESENSE-API-KEY` — so this process can use a
 * placeholder key.
 *
 * Run with:
 *   EGRESS_PROXY_URL=http://localhost:10000
 *   TYPESENSE_HOST=<cluster>.a1.typesense.net
 *   TYPESENSE_API_KEY=<key or placeholder; injected by the egress proxy>
 *   pnpm proxy-typesense
 *
 * Alternative (no fetch bridge): point the node at the proxy and pass the real
 * host as a header — axios honours a manually-set `Host` (unlike fetch):
 *   new Typesense.Client({
 *     nodes: [{ host: "localhost", port: 10000, protocol: "http" }],
 *     additionalHeaders: { Host: TYPESENSE_HOST },
 *     apiKey,
 *   });
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
      ? `Routing Typesense through egress proxy: ${egress}`
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

  const health = await client.health.retrieve();
  console.log("Typesense health:", health);

  const collections = await client.collections().retrieve();
  console.log(`Found ${collections.length} collection(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
