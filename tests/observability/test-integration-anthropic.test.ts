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

    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const original = Anthropic.Messages.prototype.create;

    // setupOnce patches the prototype and returns a teardown.
    const teardown = anthropicIntegration.setupOnce({
      tracerProvider: provider,
      handles: {},
    });
    expect(Anthropic.Messages.prototype.create).not.toBe(original);
    expect(typeof teardown).toBe("function");

    // Teardown restores the original prototype so a later init() can re-patch
    // against a new provider (the run-once guard alone wouldn't allow that).
    (teardown as () => void)();
    expect(Anthropic.Messages.prototype.create).toBe(original);
  });
});
