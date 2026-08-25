/**
 * Public-API surface smoke test.
 *
 * Imports each package entry point + the internal re-export barrels and asserts
 * representative exports resolve. This guards against a broken/renamed export
 * silently shipping, and exercises the barrel modules (otherwise reported at 0%
 * because the suite imports specific modules, never the barrels). No mocks.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
/**
 * A value import (not `import type`) of an optional framework peer.
 *
 * The scope alternatives are prefixes on purpose: `@earendil` alone never
 * matched `@earendil-works/pi-ai`, because the pattern required a `/` right
 * after the scope. That silent non-match is why the barrel could reach pi-ai
 * for two rounds with this guard green.
 */
const OPTIONAL_FRAMEWORK_IMPORT =
  /^import\s+(?!type\b)(?:[^"']+\s+from\s+)?["'](?:@anthropic-ai|@openai|@google|@earendil-works|ai|openai)(?:[/-][^"']*)?["'];/gm;

/** Every `from "..."` specifier of a value import or re-export. */
const STATIC_IMPORT_SPECIFIER =
  /^(?:import|export)\s+(?!type\b)(?:[^"';]*\sfrom\s+)?["']([^"']+)["'];/gm;

/** Workspace packages the walk can follow into, by import specifier. */
const WORKSPACE_ENTRY: Record<string, string> = {
  "@introspection-sdk/introspection-pi":
    "packages/introspection-pi/src/index.ts",
  "@introspection-sdk/types": "packages/introspection-types/src/index.ts",
  "@introspection-sdk/http": "packages/introspection-http/src/index.ts",
  "@introspection-sdk/introspection-proxy":
    "packages/introspection-proxy/src/index.ts",
};

/** Map an import specifier to the source file it resolves to, if any. */
function resolveStatic(spec: string, importer: string): string | null {
  if (spec.startsWith(".")) {
    // TS writes `./x.js`; the source next to it is `./x.ts`.
    const asTs = join(dirname(importer), spec.replace(/\.js$/, ".ts"));
    if (existsSync(asTs)) return asTs;
    const asIndex = join(dirname(importer), spec, "index.ts");
    return existsSync(asIndex) ? asIndex : null;
  }
  const entry = WORKSPACE_ENTRY[spec];
  return entry ? join(repoRoot, entry) : null;
}

describe("public export barrels", () => {
  it("@introspection-sdk/introspection-node (REST root)", async () => {
    const mod = await import("@introspection-sdk/introspection-node");
    expect(mod.IntrospectionClient).toBeTypeOf("function");
    expect(mod.HttpClient).toBeTypeOf("function");
    expect(mod.Runner).toBeTypeOf("function");
    expect(mod.RuntimesApi).toBeTypeOf("function");
    expect(mod.ConversationsApi).toBeTypeOf("function");
    expect(mod.EventsApi).toBeTypeOf("function");
    expect(mod.MetricsApi).toBeTypeOf("function");
    expect(mod.ConnectorsApi).toBeTypeOf("function");
    expect(mod.ConnectionsApi).toBeTypeOf("function");
    expect(mod.attachConnectors).toBeTypeOf("function");
    expect(mod.ReviewsApi).toBeTypeOf("function");
    expect(mod.ProjectLabelsApi).toBeTypeOf("function");
    expect(mod.foldSpans).toBeTypeOf("function");
    expect(mod.foldAgui).toBeTypeOf("function");
    expect(mod.mergeTranscripts).toBeTypeOf("function");
    expect(mod.TranscriptAccumulator).toBeTypeOf("function");
  });

  it("@introspection-sdk/introspection-node/otel (traces surface)", async () => {
    const mod = await import("@introspection-sdk/introspection-node/otel");
    for (const name of [
      "init",
      "setupTracing",
      "IntrospectionSpanProcessor",
      "IntrospectionLogs",
      "conversation",
      "withAgent",
    ] as const) {
      expect(mod[name], name).toBeTypeOf("function");
    }
  });

  it("nothing statically reachable from /otel imports an optional framework peer", () => {
    // The point of the barrel being framework-free is that `import
    // ".../otel"` works with no Pi installed. Scanning only the integrations
    // directory used to miss the edge that actually broke it: the barrel
    // re-exported `./pi.js`, which reaches `@earendil-works/pi-ai` for a
    // value through `introspection-pi`. Walk the whole static graph instead.
    const offenders: string[] = [];
    const seen = new Set<string>();
    const queue = [
      join(repoRoot, "packages/introspection-node/src/otel/index.ts"),
    ];

    while (queue.length) {
      const file = queue.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);

      let source: string;
      try {
        source = readFileSync(file, "utf8");
      } catch {
        continue;
      }

      for (const match of source.matchAll(OPTIONAL_FRAMEWORK_IMPORT)) {
        offenders.push(`${relative(repoRoot, file)}: ${match[0].trim()}`);
      }

      for (const [, spec] of source.matchAll(STATIC_IMPORT_SPECIFIER)) {
        const resolved = resolveStatic(spec, file);
        if (resolved) queue.push(resolved);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("@introspection-sdk/introspection-pi", async () => {
    const mod = await import("@introspection-sdk/introspection-pi");
    expect(mod.toAttributes).toBeTypeOf("function");
    expect(Object.keys(mod).length).toBeGreaterThan(0);
  });

  it("@introspection-sdk/types", async () => {
    const mod = await import("@introspection-sdk/types");
    expect(mod.IntrospectionAPIError).toBeTypeOf("function");
    expect(mod.apiErrorFromResponse).toBeTypeOf("function");
  });
});
