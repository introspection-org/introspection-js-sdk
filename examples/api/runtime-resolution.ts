/**
 * Runtime resolution modes + yank walkthrough.
 *
 * Demonstrates how a runtime group decides which runtime serves a run, and
 * how to withdraw ("yank") a bad runtime so it stops being resolved as the
 * active one for an environment:
 *
 *   - `sticky` (production default): a run pins the runtime active when it
 *     started and keeps it for the whole conversation, even after a newer
 *     runtime is promoted.
 *   - `latest` (non-prod default): every run resolves the currently active
 *     runtime for the environment.
 *
 * Yanking is the safety valve: a yanked runtime never resolves as active, so
 * new runs fall back to the previous active runtime (or "none active" until a
 * replacement is promoted). In-flight sticky runs keep using it.
 *
 * Run with:
 *   INTROSPECTION_TOKEN=intro_xxx
 *   INTROSPECTION_RUNTIME=<slug-or-id, optional>   (default "customer-agent")
 *   pnpm api-runtime-resolution
 *
 * Optional env:
 *   INTROSPECTION_BASE_API_URL  - CP API host (default https://api.introspection.dev)
 *
 * The project is scoped by the API key — there is no client-level project
 * option or env override.
 */

import { IntrospectionClient } from "@introspection-sdk/introspection-node";

async function main() {
  const client = new IntrospectionClient();

  const runtime = process.env.INTROSPECTION_RUNTIME ?? "customer-agent";

  // 1) Resolve what's currently serving production. `exclude_yanked` mirrors
  //    the server-side active resolution — yanked runtimes never show up here.
  const active = await client.runtimes.resolve(runtime);
  console.log(
    `active production runtime: ${active.name} (${active.id})` +
      (active.yanked_at ? ` — YANKED: ${active.yanked_reason ?? ""}` : ""),
  );

  // 2) List the production candidates for this group, newest first, omitting
  //    any that have been withdrawn.
  const candidates: string[] = [];
  for await (const runtime of client.runtimes.list({
    environment: "production",
    exclude_yanked: true,
    limit: 10,
  })) {
    candidates.push(`${runtime.name} (${runtime.id})`);
  }
  console.log(`eligible production runtimes:\n  ${candidates.join("\n  ")}`);

  // 3) Suppose the active runtime is misbehaving in production. Yank it: new
  //    runs immediately stop resolving it and fall back to the prior active
  //    runtime; conversations already pinned to it (sticky) finish unharmed.
  const yanked = await client.runtimes.yank(
    active.id,
    "regression in tool-call formatting — rolling back",
  );
  console.log(
    `yanked ${yanked.name} at ${yanked.yanked_at}: ${yanked.yanked_reason}`,
  );

  // 4) Re-resolve — the group now points production at the previous runtime
  //    (or throws NotFound if nothing else is active for the environment).
  try {
    const fallback = await client.runtimes.resolve(runtime);
    console.log(
      `production now resolves to: ${fallback.name} (${fallback.id})`,
    );
  } catch {
    console.log(
      "no active runtime for production — promote a replacement before new runs can start",
    );
  }

  // 5) If the yank was a mistake, reverse it; the runtime is eligible again.
  const restored = await client.runtimes.unyank(active.id);
  console.log(
    `restored ${restored.name}; yanked_at=${restored.yanked_at ?? "null"}`,
  );

  await client.shutdown();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
