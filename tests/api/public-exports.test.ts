/**
 * Public-API surface smoke test.
 *
 * Imports each package entry point + the internal re-export barrels and asserts
 * representative exports resolve. This guards against a broken/renamed export
 * silently shipping, and exercises the barrel modules (otherwise reported at 0%
 * because the suite imports specific modules, never the barrels). No mocks.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const OPTIONAL_FRAMEWORK_IMPORT =
  /^import\s+(?!"type\b)(?:[^"']+\s+from\s+)?["'](@anthropic-ai|@openai|@google|@langchain|@mastra|@earendil|ai|openai)(?:\/[^"']*)?["'];/gm;

describe("public export barrels", () => {
  it("@introspection-sdk/introspection-node (REST root)", async () => {
    const mod = await import("@introspection-sdk/introspection-node");
    expect(mod.IntrospectionClient).toBeTypeOf("function");
    expect(mod.HttpClient).toBeTypeOf("function");
    expect(mod.Runner).toBeTypeOf("function");
    expect(mod.ConversationsApi).toBeTypeOf("function");
    expect(mod.EventsApi).toBeTypeOf("function");
    expect(mod.MetricsApi).toBeTypeOf("function");
    expect(mod).not.toHaveProperty("RuntimesApi");
    expect(mod).not.toHaveProperty("ExperimentsApi");
    expect(mod).not.toHaveProperty("RecipesApi");
  });

  it("@introspection-sdk/http does not expose runtime control-plane helpers", async () => {
    const mod = await import("@introspection-sdk/http");
    expect(mod).not.toHaveProperty("RuntimesApi");
    expect(mod).not.toHaveProperty("RuntimesClient");
    expect(mod).not.toHaveProperty("attachRuntimes");
  });

  it("browser entrypoints keep analytics and DP execution independent", async () => {
    const analytics = await import("@introspection-sdk/introspection-browser");
    expect(analytics.IntrospectionClient).toBeTypeOf("function");
    expect(analytics).not.toHaveProperty("IntrospectionApiClient");
    expect(analytics).not.toHaveProperty("RuntimesApi");

    const api = await import("@introspection-sdk/introspection-browser/api");
    expect(api.IntrospectionApiClient).toBeTypeOf("function");
    expect(api.TasksClient).toBeTypeOf("function");
    expect(api.FilesClient).toBeTypeOf("function");
    expect(api.SharesClient).toBeTypeOf("function");
    expect(api.ConversationsClient).toBeTypeOf("function");
    expect(api).not.toHaveProperty("IntrospectionClient");
    expect(api).not.toHaveProperty("RuntimesApi");
    expect(api).not.toHaveProperty("ExperimentsApi");
    expect(api).not.toHaveProperty("RecipesApi");
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

  it("/otel integration modules do not statically import optional framework peers", () => {
    const integrationsDir = join(
      repoRoot,
      "packages/introspection-node/src/otel/integrations",
    );
    const offenders: string[] = [];

    for (const file of readdirSync(integrationsDir)) {
      if (!file.endsWith(".ts")) continue;
      const source = readFileSync(join(integrationsDir, file), "utf8");
      const matches = source.match(OPTIONAL_FRAMEWORK_IMPORT);
      if (matches?.length) {
        offenders.push(`${file}: ${matches.join(", ")}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("converters barrel", async () => {
    const mod =
      await import("../../packages/introspection-node/src/converters/index");
    expect(mod.isVercelAISpan).toBeTypeOf("function");
    expect(mod.convertVercelAIToGenAI).toBeTypeOf("function");
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
