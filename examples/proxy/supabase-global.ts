/**
 * Supabase through the Introspection egress (reverse) proxy — GLOBAL approach.
 *
 * `installProxyFetch()` replaces `globalThis.fetch` once, so supabase-js — and
 * every other `fetch` in this process — routes through the egress proxy with no
 * per-client wiring. The proxy routes by `Host` and injects the real Supabase
 * credential, so this process only needs the (non-secret) publishable key.
 *
 * Trade-off vs the manual approach (see `supabase-manual.ts`): this is the
 * simplest swap-in, but it is process-wide — in egress mode *every* outbound
 * fetch is dialed at the proxy, so every destination must be configured on it.
 *
 * Run with:
 *   INTROSPECTION_EGRESS_URL=http://localhost:10000
 *   SUPABASE_URL=https://<project>.supabase.co
 *   SUPABASE_PUBLISHABLE_KEY=<anon/publishable key>   # non-secret
 *   pnpm proxy-supabase-global
 */
import { createClient } from "@supabase/supabase-js";
import { installProxyFetch } from "@introspection-sdk/introspection-proxy";

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
      ? `Routing ALL fetch (incl. Supabase) through egress proxy: ${egress}`
      : "INTROSPECTION_EGRESS_URL unset — talking to Supabase directly.",
  );

  // One line, before any client is constructed: every fetch in this process now
  // routes through the egress proxy. No-op when INTROSPECTION_EGRESS_URL is unset.
  installProxyFetch();

  // Plain supabase-js — no proxy-specific options needed.
  const supabase = createClient(SUPABASE_URL!, SUPABASE_PUBLISHABLE_KEY!);

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
