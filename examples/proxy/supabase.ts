/**
 * Supabase through the Introspection egress (reverse) proxy.
 *
 * supabase-js issues all of its HTTP via `fetch`, so we hand it a proxy-aware
 * fetch from `@introspection-sdk/introspection-proxy`. With `EGRESS_PROXY_URL`
 * set, requests are routed to the egress proxy, which routes by `Host` and
 * injects the real Supabase credential — so this process only needs the
 * (non-secret) publishable key, never the service-role key.
 *
 * Run with:
 *   EGRESS_PROXY_URL=http://localhost:10000
 *   SUPABASE_URL=https://<project>.supabase.co
 *   SUPABASE_PUBLISHABLE_KEY=<anon/publishable key>   # non-secret
 *   pnpm proxy-supabase
 *
 * If EGRESS_PROXY_URL is unset, `createProxyFetch()` returns the global fetch
 * unchanged, so the same code talks to Supabase directly in local dev.
 */
import { createClient } from "@supabase/supabase-js";
import { createProxyFetch } from "@introspection-sdk/introspection-proxy";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  console.error(
    "Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (and EGRESS_PROXY_URL to route via the egress proxy).",
  );
  process.exit(1);
}

async function main() {
  const egress = process.env.EGRESS_PROXY_URL;
  console.log(
    egress
      ? `Routing Supabase through egress proxy: ${egress}`
      : "EGRESS_PROXY_URL unset — talking to Supabase directly.",
  );

  // The egress proxy speaks plain HTTP and injects the real upstream key, so
  // the only proxy-specific change is the custom fetch. Everything else is
  // ordinary supabase-js. (For a whole process you could instead call
  // `installProxyFetch()` once at startup and drop the `global.fetch` option.)
  const supabase = createClient(SUPABASE_URL!, SUPABASE_PUBLISHABLE_KEY!, {
    global: { fetch: createProxyFetch() },
  });

  const table = process.env.SUPABASE_TABLE ?? "todos";
  const { data, error } = await supabase.from(table).select("*").limit(5);

  if (error) {
    console.error(`Supabase error: ${error.message}`);
    process.exit(1);
  }
  console.log(`Fetched ${data?.length ?? 0} row(s) from "${table}":`, data);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
