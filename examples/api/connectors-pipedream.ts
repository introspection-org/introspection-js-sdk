/**
 * Create (or reuse) a Pipedream connector, then connect one downstream
 * application to a runtime. Connector creation is idempotent on its slug.
 *
 * Required env:
 *   INTROSPECTION_RUNTIME=<runtime group slug or ID>
 *
 * Optional env:
 *   PIPEDREAM_CONNECTOR_ID=<reuse an existing Introspection connector UUID>
 *
 * Required when PIPEDREAM_CONNECTOR_ID is omitted:
 *   PIPEDREAM_PROJECT_ID=proj_...
 *   PIPEDREAM_CLIENT_ID=...
 *   PIPEDREAM_CLIENT_SECRET=...
 *
 * Other optional env:
 *   PIPEDREAM_APP=google_sheets
 *   PIPEDREAM_PROGRESSIVE_SCOPES=true
 */

import { IntrospectionClient } from "@introspection-sdk/introspection-node";

async function main() {
  const runtime = process.env.INTROSPECTION_RUNTIME;
  const requestedApp = process.env.PIPEDREAM_APP ?? "google_sheets";
  if (!runtime) {
    throw new Error("INTROSPECTION_RUNTIME is required.");
  }

  const client = new IntrospectionClient();
  let connectorId = process.env.PIPEDREAM_CONNECTOR_ID;
  if (!connectorId) {
    const projectId = process.env.PIPEDREAM_PROJECT_ID;
    const clientId = process.env.PIPEDREAM_CLIENT_ID;
    const clientSecret = process.env.PIPEDREAM_CLIENT_SECRET;
    if (!projectId || !clientId || !clientSecret) {
      throw new Error(
        "Set PIPEDREAM_CONNECTOR_ID, or PIPEDREAM_PROJECT_ID, PIPEDREAM_CLIENT_ID, and PIPEDREAM_CLIENT_SECRET.",
      );
    }

    const connector = await client.connectors.create({
      name: "Pipedream Connect",
      slug: "pipedream-connect",
      provider: "pipedream",
      auth_mode: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      metadata: { pipedream_project_id: projectId },
    });
    connectorId = connector.id;
    console.log(`connector -> ${connector.slug} (${connector.id})`);
  }

  const applications = await client.connectors.listApps(connectorId, {
    q: requestedApp,
    limit: 5,
  });
  const application = applications.find((item) => item.slug === requestedApp);
  if (!application) {
    throw new Error(`Pipedream application not found: ${requestedApp}`);
  }

  const authorization = await client.connectors.authorize(connectorId, {
    runtime,
    app: application.slug,
    // False matches Pipedream's default. Enable this only when the application
    // supports granting a subset of its configured OAuth scopes.
    allow_progressive_scopes:
      process.env.PIPEDREAM_PROGRESSIVE_SCOPES === "true",
  });

  console.log(
    `${application.name} authorization -> ${authorization.authorize_url}`,
  );
  await client.shutdown();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
