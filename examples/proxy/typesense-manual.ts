/**
 * Typesense through the Introspection egress (reverse) proxy — MANUAL approach.
 *
 * Typesense uses axios (Node's `http` stack), which — unlike `fetch` — honours
 * a manually-set `Host` header. So instead of swapping the global fetch, we
 * point this client's node at the egress proxy and pass the real upstream host
 * as a `Host` header. The proxy routes by `Host` and injects the real
 * `X-TYPESENSE-API-KEY`. Only this client is proxied; nothing else in the
 * process is affected, and no fetch is involved.
 *
 * Trade-off vs the global approach (see `typesense-global.ts`): scoped to this
 * client, but you point the node at the proxy and fall back to the real host
 * when EGRESS_PROXY_URL is unset.
 *
 * Run with:
 *   EGRESS_PROXY_URL=http://localhost:10000
 *   TYPESENSE_HOST=<cluster>.a1.typesense.net
 *   TYPESENSE_API_KEY=<key or placeholder; injected by the egress proxy>
 *   pnpm proxy-typesense-manual
 */
import Typesense from "typesense";

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
      ? `Routing this Typesense client through egress proxy: ${egress}`
      : "EGRESS_PROXY_URL unset — talking to Typesense directly.",
  );

  // The only proxy-specific change is on this client: point its node at the
  // egress proxy and pass the real host as a Host header (axios honours it;
  // fetch would drop it). Nothing else in the process is affected.
  const proxy = egress ? new URL(egress) : null;
  const client = new Typesense.Client({
    nodes: [
      proxy
        ? {
            host: proxy.hostname,
            port: Number(proxy.port) || 80,
            protocol: "http",
          }
        : { host: TYPESENSE_HOST!, port: 443, protocol: "https" },
    ],
    apiKey: TYPESENSE_API_KEY!,
    connectionTimeoutSeconds: 10,
    ...(proxy ? { additionalHeaders: { Host: TYPESENSE_HOST! } } : {}),
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
