/**
 * Public-API surface smoke test.
 *
 * Imports each package entry point + the internal re-export barrels and asserts
 * representative exports resolve. This guards against a broken/renamed export
 * silently shipping, and exercises the barrel modules (otherwise reported at 0%
 * because the suite imports specific modules, never the barrels). No mocks.
 */
import { describe, expect, it } from "vitest";

describe("public export barrels", () => {
  it("@introspection-sdk/introspection-node (REST root)", async () => {
    const mod = await import("@introspection-sdk/introspection-node");
    expect(mod.IntrospectionClient).toBeTypeOf("function");
    expect(mod.HttpClient).toBeTypeOf("function");
    expect(mod.Runner).toBeTypeOf("function");
    expect(mod.RuntimesApi).toBeTypeOf("function");
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
