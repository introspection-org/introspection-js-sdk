/**
 * The end user's own connect button: list the apps the caller has connected,
 * and mint a connect link for one.
 *
 * Run with a token for the end user (a runner or member token):
 *   INTROSPECTION_TOKEN=intro_xxx
 *   INTROSPECTION_APP=<app slug, e.g. slack>
 *   node --import tsx patterns/per-user-tools-connect.ts
 *
 * Not run in the examples workflow: the app must be served through a
 * Pipedream connector the job's project does not have.
 *
 * Optional env:
 *   INTROSPECTION_BASE_API_URL  - CP API host
 */

import { IntrospectionClient } from "@introspection-sdk/introspection-node";

for (const name of ["INTROSPECTION_TOKEN", "INTROSPECTION_APP"]) {
  if (!process.env[name]) throw new Error(`Set ${name}.`);
}
const client = new IntrospectionClient();
const app = process.env.INTROSPECTION_APP!;

// #region docs:patterns/per-user-tools/connect-button
const mine = await client.connections.list({ app });
const { authorize_url } = await client.connections.create({ app, runtime: "support-agent" });
// #endregion docs:patterns/per-user-tools/connect-button

console.log(`connections: ${JSON.stringify(mine)}`);
console.log(`connect link: ${authorize_url}`);
