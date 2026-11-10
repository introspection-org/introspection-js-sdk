/**
 * A review queue over a project's annotations: how many there are, and the
 * annotations before and after the first one in the review order.
 *
 * Run with:
 *   INTROSPECTION_TOKEN=intro_xxx
 *   pnpm api-annotations-review
 *
 * Optional env:
 *   INTROSPECTION_BASE_API_URL  - CP API host (default https://api.introspection.dev)
 *   INTROSPECTION_DP_URL        - the project's Data Plane, when it is not on the CP host
 */

import { IntrospectionClient } from "@introspection-sdk/introspection-node";

async function main() {
  const client = new IntrospectionClient({
    advanced: { dpUrl: process.env.INTROSPECTION_DP_URL },
  });

  // Add `label` to size one dataset the same way.
  const { records, total_count } = await client.annotations.list({
    limit: 1,
    include_total: true,
  });
  console.log(`${total_count ?? 0} annotated spans`);
  const first = records[0];
  if (!first) return;
  const reviewed = await client.annotations.list({
    trace_id: first.trace_id,
    span_id: first.span_id,
    status: "reviewed",
  });
  console.log(
    `${reviewed.records.length ? "reviewed" : "not reviewed"}: ${first.span_id}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
