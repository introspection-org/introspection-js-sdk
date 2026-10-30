/**
 * A review queue over a project's annotations: the buckets it filters by, and
 * the annotations before and after the first one in the review order.
 *
 * Run with:
 *   INTROSPECTION_TOKEN=intro_xxx
 *   pnpm api-annotations-review
 *
 * Optional env:
 *   INTROSPECTION_BASE_API_URL  - CP API host (default https://api.introspection.dev)
 */

import { IntrospectionClient } from "@introspection-sdk/introspection-node";

async function main() {
  const client = new IntrospectionClient();

  for (const facet of await client.annotations.facets()) {
    console.log(`${facet.dimension}=${facet.value}: ${facet.count}`);
  }

  const { records } = await client.annotations.list();
  const first = records[0];
  if (!first) return;
  const around = await client.annotations.navigation({
    trace_id: first.trace_id,
    span_id: first.span_id,
    status: "reviewed",
  });
  console.log(
    `${around.current_position ?? "-"} of ${around.total_count}, next: ${around.next?.span_id ?? "none"}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
