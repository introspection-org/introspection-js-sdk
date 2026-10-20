/**
 * Let each end user connect their own account to an app the agent uses.
 *
 * Mints an authorize link for an end user through a Pipedream connector. The
 * end user's own connect button is `per-user-tools-connect.ts`.
 * Not run in the examples workflow: it needs a Pipedream connector the job's
 * project does not have.
 *
 * Run with:
 *   INTROSPECTION_TOKEN=intro_xxx
 *   INTROSPECTION_CONNECTOR_ID=<pipedream connector id>
 *   INTROSPECTION_APP=<app slug, e.g. slack>
 *   pnpm patterns-per-user-tools
 *
 * Optional env:
 *   INTROSPECTION_BASE_API_URL  - CP API host
 */

import { IntrospectionClient } from "@introspection-sdk/introspection-node";

for (const name of [
  "INTROSPECTION_TOKEN",
  "INTROSPECTION_CONNECTOR_ID",
  "INTROSPECTION_APP",
]) {
  if (!process.env[name]) throw new Error(`Set ${name}.`);
}
const client = new IntrospectionClient();
const connectorId = process.env.INTROSPECTION_CONNECTOR_ID!;
const app = process.env.INTROSPECTION_APP!;

// #region docs:patterns/per-user-tools/mint-link
const { authorize_url } = await client.connectors.authorize(connectorId, {
  app,
  runtime: "support-agent",
  identity: { user_id: "user-4821" },
  expires_in: 3600,
});
// #endregion docs:patterns/per-user-tools/mint-link

console.log(`authorize link for user-4821: ${authorize_url}`);
