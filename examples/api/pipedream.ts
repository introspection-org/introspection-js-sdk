/**
 * Server-side Pipedream account connection using an existing configured connector.
 * Supply the same verified customer ID when opening the customer's agent runner.
 * The host application must authenticate the customer before calling this function.
 * Never expose the platform credential or accept an arbitrary customer ID from a form.
 */
import { IntrospectionClient } from "@introspection-sdk/introspection-node";

export async function connectOutlook(
  client: IntrospectionClient,
  connectorId: string,
  runtime: string,
  authenticatedCustomerId: string,
  returnUrl: string,
) {
  const apps = await client.connectors.listApps(connectorId, {
    q: "outlook",
    limit: 5,
  });
  const app = apps.find((candidate) => candidate.slug === "microsoft_outlook");
  if (!app)
    throw new Error("Outlook is unavailable in this connector catalogue");

  // Mint a fresh link for each attempt. Its single-use state must not be cached.
  return client.connectors.authorize(connectorId, {
    app: app.slug,
    runtime,
    identity: { user_id: authenticatedCustomerId },
    allow_progressive_scopes: false,
    return_url: returnUrl,
  });
}

export async function connectedAccounts(
  client: IntrospectionClient,
  connectorId: string,
  authenticatedCustomerId: string,
) {
  // Fetch after the browser returns from consent. Creating a link alone does
  // not mean the customer has connected an account.
  return client.connectors.listAccounts(connectorId, {
    identity_user_id: authenticatedCustomerId,
  });
}
