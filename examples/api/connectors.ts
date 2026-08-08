/**
 * B2B2C connector walkthrough — the flow a Business runs from its own
 * backend, without ever touching the Introspection UI.
 *
 * Creates a Slack connector for the org, mints the install link that gets
 * handed to a customer, then lists the workspaces that connected and
 * (optionally) disconnects one.
 *
 * Run with:
 *   INTROSPECTION_TOKEN=intro_xxx
 *   SLACK_CLIENT_ID=<your Slack app client id>
 *   SLACK_CLIENT_SECRET=<your Slack app client secret>
 *   INTROSPECTION_RUNTIME=<runtime group slug or ID>
 *   pnpm api-connectors
 *
 * Optional env:
 *   INTROSPECTION_BASE_API_URL  - CP API host (default https://api.introspection.dev)
 *   INTROSPECTION_PROJECT       - project slug or id, when the key is not project-scoped
 *   REVOKE_FIRST_CONNECTION=1   - revoke the first listed connection (destructive)
 *
 * Connectors sit behind a server-side feature flag. If every call 404s with
 * "Connectors are not enabled", the deployment has not opted in yet.
 */

import { IntrospectionClient } from "@introspection-sdk/introspection-node";

async function main() {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = process.env.SLACK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "SLACK_CLIENT_ID and SLACK_CLIENT_SECRET are required — they are your own Slack app's credentials.",
    );
  }

  const client = new IntrospectionClient();
  // Only needed when the API key is not already scoped to one project.
  const project = process.env.INTROSPECTION_PROJECT;
  const scope = project ? { project } : {};

  // 1) Create the connector. This is the org-level definition of the
  //    provider: your Slack app's credentials plus the scopes it asks for.
  //    Create is idempotent on `slug`, so re-running this is safe — it
  //    returns the existing row rather than a duplicate. `client_secret` is
  //    write-only: it goes up here and is absent from every response.
  const connector = await client.connectors.create(
    {
      name: "Slack (support)",
      slug: "slack-support",
      provider: "slack",
      auth_mode: "oauth_stored",
      scopes: ["chat:write", "channels:read", "app_mentions:read"],
      api_hosts: ["slack.com"],
      client_id: clientId,
      client_secret: clientSecret,
    },
    scope,
  );
  console.log(
    `connector -> ${connector.slug} (${connector.id}), status=${connector.status}`,
  );

  // 2) Mint the install link. This is the whole point of the SDK surface:
  //    the URL below is what you put in front of *your* customer, in your
  //    own product, so their Slack workspace connects to an agent.
  //
  //    `requires_runtime` is derived server-side from the provider — read it
  //    rather than hardcoding which providers are chat providers. When it is
  //    true, `runtime` names the agent that answers the messages, and
  //    omitting it is a 422.
  const runtime = process.env.INTROSPECTION_RUNTIME;
  if (connector.requires_runtime && !runtime) {
    throw new Error(
      `${connector.provider} delivers conversations, so INTROSPECTION_RUNTIME must name the runtime that replies.`,
    );
  }

  const install = await client.connectors.authorize(connector.id, {
    ...(runtime ? { runtime } : {}),
    // The default (600s) suits following the link immediately. Raise it when
    // the link is emailed to someone else — an admin does not open it in ten
    // minutes. The ceiling is 86400 (one day).
    expires_in: 3600,
  });
  console.log(`install link -> ${install.authorize_url}`);
  console.log(
    `  valid for ${install.expires_in}s (until ${install.expires_at})`,
  );
  //    The URL carries a single-use `state`: it is a bearer capability for
  //    exactly one install. Hand it to one recipient, do not cache it, and
  //    mint a fresh one per customer — two calls return two different URLs.

  // 3) List what connected. For Slack each connection is one workspace that
  //    completed the install; `member_id` is the workspace's customer member
  //    and `runtime_group_id` is the agent answering it. Tokens are never
  //    serialized.
  const connections = [];
  for await (const connection of client.connectors.connections.list(
    connector.id,
  )) {
    connections.push(connection);
    console.log(
      `  connection ${connection.id}: subject=${connection.subject_type}, status=${connection.status}, member=${connection.member_id ?? "-"}`,
    );
  }
  if (connections.length === 0) {
    console.log("  (none yet — open the install link above to connect one)");
  }

  // 4) Disconnect one. Revoking destroys the provider token behind that one
  //    connection; the connector and its other connections are untouched, and
  //    the customer must re-consent through a fresh install link.
  if (process.env.REVOKE_FIRST_CONNECTION === "1" && connections[0]) {
    await client.connectors.connections.revoke(connector.id, connections[0].id);
    console.log(`revoked connection ${connections[0].id}`);
  }

  await client.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
