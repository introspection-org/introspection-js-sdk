/**
 * Connect a custom MCP app (Linear by default) to a runtime end to end:
 * find it in the open MCP registry, discover its OAuth server, create the
 * connector, and mint a consent URL that also binds the runtime's MCP
 * endpoint. Re-creating a connector with the same slug updates it in place.
 *
 * Required env:
 *   INTROSPECTION_RUNTIME=<runtime group slug or ID>
 *
 * Optional env:
 *   CUSTOM_APP=linear                  - registry search text (default "linear")
 *   MCP_URL=https://mcp.linear.app/mcp - skip the registry search and use this URL
 *   INTROSPECTION_ENVIRONMENT=production - lane for the connector and binding
 */

import { IntrospectionClient } from "@introspection-sdk/introspection-node";
import type { ConnectorAuthorizeBinding } from "@introspection-sdk/introspection-node";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function main() {
  const runtime = process.env.INTROSPECTION_RUNTIME;
  if (!runtime) {
    throw new Error("INTROSPECTION_RUNTIME is required.");
  }
  const query = process.env.CUSTOM_APP ?? "linear";
  const environment = (process.env.INTROSPECTION_ENVIRONMENT ??
    "production") as ConnectorAuthorizeBinding["environment"];

  const client = new IntrospectionClient();

  // 1) Find the app's MCP server in the open registry (no connector needed).
  let appName = query;
  let mcpUrl = process.env.MCP_URL;
  if (!mcpUrl) {
    const listings = await client.connectors.searchCustomApps({
      q: query,
      limit: 10,
    });
    const listing = listings.find((item) => item.mcp_url);
    if (!listing?.mcp_url) {
      throw new Error(`No registry listing with an MCP server for: ${query}`);
    }
    appName = listing.name;
    mcpUrl = listing.mcp_url;
  }
  console.log(`mcp server -> ${mcpUrl}`);

  // 2) Discover the OAuth server. This may register a client with the
  //    provider; reuse it below so a second one is not registered.
  const discovered = await client.connectors.discoverOAuth(mcpUrl);
  console.log(
    `client registration -> ${discovered.client_registration ?? "none"}`,
  );
  console.log(`scopes supported -> ${discovered.scopes_supported.join(" ")}`);

  // 3) Create the connector. A custom app named "Linear" gets provider
  //    `linear`, which is runtime-bound: authorize must name a runtime.
  const provider = slugify(appName);
  const connector = await client.connectors.create({
    name: appName,
    slug: provider,
    provider,
    auth_mode: "oauth_stored",
    environment,
    issuer: mcpUrl,
    api_hosts: [new URL(mcpUrl).host],
    scopes: discovered.scopes_supported,
    ...(discovered.client_id ? { client_id: discovered.client_id } : {}),
    ...(discovered.client_secret
      ? { client_secret: discovered.client_secret }
      : {}),
  });
  console.log(`connector -> ${connector.slug} (${connector.id})`);

  // 4) Mint the consent URL. The binding writes the runtime's MCP endpoint in
  //    the same transaction as the grant, so it is never authorized-but-unbound.
  const authorization = await client.connectors.authorize(connector.id, {
    runtime,
    binding: { environment, mcp_server_id: provider, url: mcpUrl },
  });

  // 5) A human opens this URL to consent.
  console.log(`${appName} authorization -> ${authorization.authorize_url}`);
  await client.shutdown();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
