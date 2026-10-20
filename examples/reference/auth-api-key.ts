/**
 * Authentication reference: API key.
 *
 * Backs the docs' Authentication page, "API key" (region
 * `reference/authentication/api-key`). The region is module-level and
 * carries its import, as the docs do; the code below it checks that both
 * clients authenticate.
 *
 * Run with:
 *   INTROSPECTION_TOKEN=intro_xxx
 *   pnpm reference-auth-api-key
 *
 * Optional env:
 *   INTROSPECTION_BASE_API_URL  - CP API host (default https://api.introspection.dev)
 */

if (!process.env.INTROSPECTION_TOKEN) {
  console.error(
    "INTROSPECTION_TOKEN is not set: export a project API key (intro_...)",
  );
  process.exit(1);
}

// #region docs:reference/authentication/api-key
import { IntrospectionClient } from "@introspection-sdk/introspection-node";

const client = new IntrospectionClient();

// Or pass it explicitly.
const explicit = new IntrospectionClient({
  token: process.env.INTROSPECTION_TOKEN,
});
// #endregion docs:reference/authentication/api-key

for (const [name, c] of [["default", client], ["explicit", explicit]] as const) {
  const page = await c.runtimes.list();
  console.log(`${name} client: ${page.records.length} runtime(s)`);
  await c.shutdown();
}
