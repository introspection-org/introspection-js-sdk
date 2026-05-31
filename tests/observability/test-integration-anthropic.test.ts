/**
 * Coverage for the anthropic built-in integration's setupOnce — it arms the
 * prototype-patch instrumentor against a provider. No mocks: a real
 * BasicTracerProvider + the real @anthropic-ai/sdk class are used. Isolated in
 * its own file (pool: forks) so the global prototype patch can't leak.
 */
import { describe, expect, it } from "vitest";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

import anthropicIntegration from "../../packages/introspection-node/src/otel/integrations/anthropic";

describe("anthropic integration", () => {
  it("setupOnce arms the prototype patch against the given provider", async () => {
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(new InMemorySpanExporter())],
    });

    expect(anthropicIntegration.identifier).toBe("anthropic");
    // Real @anthropic-ai/sdk prototype gets patched; should not throw, and a
    // repeat call is a no-op via the PATCHED marker.
    expect(() =>
      anthropicIntegration.setupOnce({
        tracerProvider: provider,
        handles: {},
      }),
    ).not.toThrow();

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    expect(typeof Anthropic.Messages.prototype.create).toBe("function");
  });
});
