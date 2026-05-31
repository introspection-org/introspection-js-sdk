import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");

export default defineConfig({
  root: repoRoot,
  // Resolve the workspace's `@introspection-sdk/*` packages to their `src/`
  // entry points (instead of the published `dist/` artefacts) during tests.
  // Two effects:
  //   1. Coverage maps to src/ directly, no source-map round-trip needed.
  //   2. Tests pick up SDK source changes without a rebuild step in between.
  resolve: {
    alias: {
      "@introspection-sdk/introspection-node/langchain": resolve(
        repoRoot,
        "packages/introspection-node/src/otel/langchain-handler.ts",
      ),
      "@introspection-sdk/introspection-node/mastra": resolve(
        repoRoot,
        "packages/introspection-node/src/otel/mastra-exporter.ts",
      ),
      "@introspection-sdk/introspection-node/otel": resolve(
        repoRoot,
        "packages/introspection-node/src/otel/index.ts",
      ),
      "@introspection-sdk/introspection-node": resolve(
        repoRoot,
        "packages/introspection-node/src/index.ts",
      ),
      "@introspection-sdk/introspection-pi": resolve(
        repoRoot,
        "packages/introspection-pi/src/index.ts",
      ),
      "@introspection-sdk/introspection-openclaw": resolve(
        repoRoot,
        "packages/introspection-openclaw/src/index.ts",
      ),
      "@introspection-sdk/introspection-browser": resolve(
        repoRoot,
        "packages/introspection-browser/src/index.ts",
      ),
      "@introspection-sdk/types": resolve(
        repoRoot,
        "packages/introspection-types/src/index.ts",
      ),
    },
  },
  test: {
    globals: false,
    testTimeout: 60000, // 60s for API calls
    hookTimeout: 30000,
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup-env.ts"],
    // Each test FILE runs in its own forked process. OTel global state
    // (context manager, tracer provider, propagator) cannot leak across
    // files. Within a single file, tests share state — that's intentional
    // and the file's beforeEach / beforeAll is responsible for the reset.
    // `isolate: true` is the top-level form in Vitest 4 — older `poolOptions`
    // shape was removed (see https://vitest.dev/guide/migration#pool-rework).
    pool: "forks",
    isolate: true,
    // ── Coverage ───────────────────────────────────────────────────────
    //
    // Activated via `pnpm test:cov`. Reports the lines/branches/functions
    // actually exercised across the SDK source files (the `include` glob
    // intentionally excludes test files, dist artefacts, and converters
    // that have their own dedicated suites). Reporters:
    //
    //   - text          stdout summary so CI logs show the pass/fail
    //   - json-summary  machine-readable for downstream gating
    //   - html          coverage/index.html for local inspection
    //
    // Thresholds are currently set to the baseline measured at the time
    // this was wired up (see docs/cleanup-plan.md Phase 1). They are
    // **not aspirational**: their job is "don't regress". Raising them
    // happens in Phase 4 once new tests are written for the gap files.
    //
    // To skip coverage in normal runs use `pnpm test` (no --coverage flag).
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      // `all: true` forces the v8 provider to enumerate every matching
      // source file, not just the ones loaded by tests. Without it,
      // un-imported files (e.g. converters used only by absent tests)
      // silently disappear from the report instead of showing 0% — which
      // is exactly the visibility we're adding coverage for.
      all: true,
      // Resolved via the workspace's symlinks: pnpm wires
      // `@introspection-sdk/*` → `packages/*/dist/`, and SDK packages
      // emit `.js.map` files (see typescript-config/base.json sourceMap),
      // so v8 maps execution back to src/. Both src and dist are listed
      // so file enumeration matches whichever path the report shows.
      include: [
        "packages/introspection-node/src/**/*.ts",
        "packages/introspection-pi/src/**/*.ts",
        "packages/introspection-openclaw/src/**/*.ts",
        "packages/introspection-browser/src/**/*.ts",
        "packages/introspection-types/src/**/*.ts",
      ],
      exclude: [
        "**/*.test.ts",
        "**/*.d.ts",
        "**/dist/**",
        "**/node_modules/**",
        // Version constant — no logic to test.
        "**/version.ts",
      ],
      // "Do not regress" floor — CI / pre-commit fails if a PR drops below
      // any of these. Raised in the unification-surface pass after the
      // gap-closing tests landed (REST control-plane against a real HTTP
      // server, openinference reverse converter + exporter, typed-error
      // mapping, setupTracing dual-export, the otel/register preload).
      //
      // Phase 1 baseline:  statements 62.86%  branches 48.65%  functions 64.65%  lines 64.24%
      // Current measured:  statements 73.44%  branches 57.80%  functions 79.20%  lines 75.00%
      // Floors sit just under the measured values to leave a small margin.
      thresholds: {
        lines: 70,
        functions: 72,
        branches: 53,
        statements: 70,
      },
    },
  },
});
