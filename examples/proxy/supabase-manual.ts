/**
 * Supabase through the Introspection egress (reverse) proxy — MANUAL approach.
 *
 * Instead of replacing the global fetch, we hand a proxy-aware fetch from
 * `createProxyFetch()` to a single supabase-js client via its `global.fetch`
 * option. Only this client is proxied; the rest of the process keeps using the
 * normal global fetch. The proxy routes by `Host` and injects the real Supabase
 * credential, so this process only needs the (non-secret) publishable key.
 *
 * Trade-off vs the global approach (see `supabase-global.ts`): a touch more
 * wiring, but the proxy is scoped to exactly this client — the safer default for
 * app code that also talks to hosts the egress proxy doesn't know about.
 *
 * Run with:
 *   INTROSPECTION_EGRESS_URL=http://localhost:10000
 *   SUPABASE_URL=https://<project>.supabase.co
 *   SUPABASE_PUBLISHABLE_KEY=<anon/publishable key>   # non-secret
 *   pnpm proxy-supabase-manual
 *
 * If INTROSPECTION_EGRESS_URL is unset, `createProxyFetch()` returns the global fetch
 * unchanged, so the same code talks to Supabase directly in local dev.
 */
import { createClient } from "@supabase/supabase-js";
import { createProxyFetch } from "@introspection-sdk/introspection-proxy";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
  console.error(
    "Set SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY (and INTROSPECTION_EGRESS_URL to route via the egress proxy).",
  );
  process.exit(1);
}

async function main() {
  const egress = process.env.INTROSPECTION_EGRESS_URL;
  console.log(
    egress
      ? `Routing this Supabase client through egress proxy: ${egress}`
      : "INTROSPECTION_EGRESS_URL unset — talking to Supabase directly.",
  );

  // The only proxy-specific change is the per-client fetch; everything else is
  // ordinary supabase-js, and nothing else in the process is affected.
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
