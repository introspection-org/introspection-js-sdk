/**
 * Authentication reference: service-account application.
 *
 * Backs the docs' Authentication page, "Service-account application"
 * (region `reference/authentication/service-account`). The region is
 * module-level and carries its import, as the docs do.
 *
 * Run with:
 *   INTROSPECTION_SERVICE_ACCOUNT_CLIENT_ID=intro_app_xxx
 *   INTROSPECTION_SERVICE_ACCOUNT_CLIENT_SECRET=intro_sk_xxx
 *   INTROSPECTION_PROJECT=<project slug or ID>
 *   pnpm reference-auth-service-account
 *
 * Optional env:
 *   INTROSPECTION_BASE_API_URL  - CP API host (default https://api.introspection.dev)
 */

// Narrows the env vars the region reads to `string`.
if (
  !process.env.INTROSPECTION_SERVICE_ACCOUNT_CLIENT_ID ||
  !process.env.INTROSPECTION_SERVICE_ACCOUNT_CLIENT_SECRET ||
  !process.env.INTROSPECTION_PROJECT
) {
  console.error(
    "Set INTROSPECTION_SERVICE_ACCOUNT_CLIENT_ID, INTROSPECTION_SERVICE_ACCOUNT_CLIENT_SECRET and INTROSPECTION_PROJECT",
  );
  process.exit(1);
}

// #region docs:reference/authentication/service-account
import { IntrospectionClient } from "@introspection-sdk/introspection-node";

const client = await IntrospectionClient.fromServiceAccount({
  clientId: process.env.INTROSPECTION_SERVICE_ACCOUNT_CLIENT_ID,
  clientSecret: process.env.INTROSPECTION_SERVICE_ACCOUNT_CLIENT_SECRET,
  project: process.env.INTROSPECTION_PROJECT,
});
// #endregion docs:reference/authentication/service-account

const page = await client.runtimes.list();
console.log(`service account sees ${page.records.length} runtime(s)`);
await client.shutdown();
