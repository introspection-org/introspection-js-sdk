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
  oidcLogout,
} from "@introspection-sdk/introspection-node";

async function main() {
  const project = process.env.INTROSPECTION_PROJECT;
  if (!project) throw new Error("Set INTROSPECTION_PROJECT");

  const login = new DeviceCodeAuth();
  const device = await login.requestCode({ project });
  console.log(`Open ${device.verification_uri} and enter ${device.user_code}`);
  const token = await login.waitForToken(device);

  const client = new IntrospectionClient({ token: token.access_token });
  const org = await client.organizations.me();
  console.log(`signed in to ${org.slug}`);

  const minted = await client.tokens.create({ project, expires_hours: 1 });
  console.log(`Data Plane token, expires ${minted.expires_at}`);

  const member = new IntrospectionClient({ token: minted.access_token });
  const docs = await member.remotes.connectDocs();
  console.log(`remote protocol v${docs.schema_version} at ${docs.endpoint}`);

  // The login's cookie, kept from the first token: a refresh may not repeat it.
  if (token.cp_session) await oidcLogout({ cpSession: token.cp_session });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
