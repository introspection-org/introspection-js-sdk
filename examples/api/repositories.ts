/**
 * A repository hosted on the project's Data Plane, and the short-lived token a
 * sandbox mints to reach a repository its Runtime is granted.
 *
 * Run with:
 *   INTROSPECTION_TOKEN=intro_xxx
 *   INTROSPECTION_PROJECT=<project slug or id>
 *   pnpm api-repositories
 *
 * Optional env:
 *   INTROSPECTION_RUNNER_TOKEN  - a runner's token, inside a sandbox; only that
 *                                 credential qualifies for an access token
 *   INTROSPECTION_BASE_API_URL  - CP API host (default https://api.introspection.dev)
 *   INTROSPECTION_DP_URL        - the project's Data Plane, when it is not on the CP host
 */

import { IntrospectionClient } from "@introspection-sdk/introspection-node";

async function main() {
  const project = process.env.INTROSPECTION_PROJECT;
  if (!project) throw new Error("Set INTROSPECTION_PROJECT");

  const client = new IntrospectionClient();
  // Idempotent on the slug, so a second run finds the same repository.
  const repository = await client.repositories.create(
    { provider: "hosted", slug: "example-agent", default_branch: "main" },
    { project },
  );
  console.log(`repository ${repository.slug} at ${repository.url}`);

  const runnerToken = process.env.INTROSPECTION_RUNNER_TOKEN;
  if (runnerToken) {
    const sandbox = new IntrospectionClient({
      token: runnerToken,
      advanced: { dpUrl: process.env.INTROSPECTION_DP_URL },
    });
    const grant = await sandbox.repositories.accessToken(repository.id, {
      permissions: { contents: "read" },
    });
    console.log(`${grant.repository}: token expires ${grant.expires_at}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
