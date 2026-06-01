/**
 * shutdown() → init() re-initialisation. Verifies the fix for the run-once /
 * teardown inconsistency: shutdown() must run integration teardowns and clear
 * the install guard so a later init() re-installs and rebuilds handles against
 * the new provider (rather than being skipped). No mocks.
 */
import { afterEach, describe, expect, it } from "vitest";
import { context, propagation, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import {
  init,
  shutdown,
  _resetForTests,
  getLangchainHandler,
  getMastraExporter,
} from "../../packages/introspection-node/src/otel/init";
import type { Integration } from "../../packages/introspection-node/src/otel/integrations/index";

function resetOTelGlobals() {
  context.disable();
  propagation.disable();
  trace.disable();
}

const baseOpts = () => ({
  token: "test-token",
  onConflict: "replace" as const,
  advanced: { spanExporter: new InMemorySpanExporter() },
});

describe("re-init after shutdown()", () => {
  afterEach(async () => {
    await shutdown();
    _resetForTests();
    resetOTelGlobals();
  });

  it("runs teardowns and re-installs custom integrations on the next init()", async () => {
    let setups = 0;
    let teardowns = 0;
    const custom: Integration = {
      identifier: "reinit-probe",
      setupOnce() {
        setups++;
        return () => {
          teardowns++;
        };
      },
    };

    await init({ ...baseOpts(), autoDiscover: false, integrations: [custom] });
    expect(setups).toBe(1);
    expect(teardowns).toBe(0);

    await shutdown();
    expect(teardowns).toBe(1); // teardown ran on shutdown

    // The install guard was cleared, so setupOnce runs again (not skipped).
    await init({ ...baseOpts(), autoDiscover: false, integrations: [custom] });
    expect(setups).toBe(2);
  });

  it("rebuilds auto-discovered handles after shutdown + re-init", async () => {
    await init({ ...baseOpts(), autoDiscover: true });
    // @langchain/core + @mastra/core are installed (dev deps), so discovery
    // publishes their handles.
    expect(() => getLangchainHandler()).not.toThrow();
    expect(() => getMastraExporter()).not.toThrow();

    await shutdown();

    // Before the fix, the run-once guard skipped re-install and these threw.
    await init({ ...baseOpts(), autoDiscover: true });
    expect(() => getLangchainHandler()).not.toThrow();
    expect(() => getMastraExporter()).not.toThrow();
  });
});
