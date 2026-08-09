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
  instrumentPi,
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

  // `instrumentPi` throws a distinctive "not configured" error when the Pi
  // handle is absent, and some other error once the handle is bound (the
  // stub agent below is not a real pi Agent). Only the former means the
  // handle failed to rebuild, so that is what we assert on.
  const piHandleBound = (): boolean => {
    try {
      instrumentPi({ streamFn: () => undefined } as never, {} as never);
      return true;
    } catch (e) {
      return !String(e).includes("Pi integration not configured");
    }
  };

  it("rebuilds auto-discovered handles after shutdown + re-init", async () => {
    await init({ ...baseOpts(), autoDiscover: true });
    // @earendil-works/pi-agent-core is installed (dev dep), so discovery
    // publishes its handle.
    expect(piHandleBound()).toBe(true);

    await shutdown();

    // Before the fix, the run-once guard skipped re-install and this threw.
    await init({ ...baseOpts(), autoDiscover: true });
    expect(piHandleBound()).toBe(true);
  });
});
