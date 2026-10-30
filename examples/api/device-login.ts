/**
 * The login `introspection login` does (RFC 8628), then what that login can
 * read: its organization, a Data Plane token for one project, and the protocol
 * of the WebSocket `introspection dev` dials.
 *
 * Run with:
 *   INTROSPECTION_PROJECT=<project slug or id>
 *   pnpm api-device-login
 *
 * Optional env:
 *   INTROSPECTION_BASE_API_URL  - CP API host (default https://api.introspection.dev)
 */

import {
  DeviceCodeAuth,
  IntrospectionClient,
} from "@introspection-sdk/introspection-node";

async function main() {
  const project = process.env.INTROSPECTION_PROJECT;
  if (!project) throw new Error("Set INTROSPECTION_PROJECT");

  const login = new DeviceCodeAuth();
  const device = await login.requestCode({ project });
  console.log(`Open ${device.verification_uri} and enter ${device.user_code}`);
  const token = await login.waitForToken(device);

  // A login's Control Plane routes go through its cookie, and its Data Plane
  // is the one it resolved, which need not be on the Control Plane's host.
  const dpUrl = token.dp_url ?? undefined;
  const client = new IntrospectionClient({
    cpSession: token.cp_session ?? undefined,
    advanced: { dpUrl },
  });
  const org = await client.organizations.me();
  console.log(`signed in to ${org.slug}`);

  const minted = await client.tokens.create({ project, expires_hours: 1 });
  console.log(`Data Plane token, expires ${minted.expires_at}`);

  const member = new IntrospectionClient({
    token: minted.access_token,
    advanced: { dpUrl },
  });
  const docs = await member.remotes.connectDocs();
  console.log(`remote protocol v${docs.schema_version} at ${docs.endpoint}`);

  // Ends this login alone; `oidcLogout` would sign the member out everywhere.
  await login.revoke({
    sessionId: token.session_id!,
    orgId: token.org_id!,
    token: token.refresh_token!,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
