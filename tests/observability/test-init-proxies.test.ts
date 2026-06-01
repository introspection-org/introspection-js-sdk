/**
 * Coverage for the init() baggage proxies (withAgent / withConversation /
 * withUserId / withAnonymousId) and the init() partial-state rollback.
 * No mocks: a real InMemorySpanExporter stands in for the token.
 */
import { afterEach, describe, expect, it } from "vitest";
import { context, propagation, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import {
  init,
  withAgent,
  withConversation,
  withUserId,
  withAnonymousId,
  getTracerProvider,
  shutdown,
  _resetForTests,
} from "../../packages/introspection-node/src/otel/init";
import type { Integration } from "../../packages/introspection-node/src/otel/integrations/index";

function resetOTelGlobals() {
  context.disable();
  propagation.disable();
  trace.disable();
}

async function initForTest() {
  await init({
    token: "test-token",
    serviceName: "init-proxies-test",
    autoDiscover: false,
    onConflict: "replace",
    advanced: { spanExporter: new InMemorySpanExporter() },
  });
}

describe("init() baggage proxies", () => {
  afterEach(async () => {
    await shutdown();
    _resetForTests();
    resetOTelGlobals();
  });

  it("throw before init() (require getClient)", () => {
    expect(() => withAgent("bot", "a1", () => 1)).toThrow(/init/);
    expect(() => withConversation("c1", undefined, () => 1)).toThrow(/init/);
    expect(() => withUserId("u1", () => 1)).toThrow(/init/);
    expect(() => withAnonymousId("anon", () => 1)).toThrow(/init/);
  });

  it("set the expected baggage entries inside the scope after init()", async () => {
    await initForTest();

    const seen = await withAgent("support-bot", "agent_1", () =>
      withConversation("conv_1", "resp_0", () =>
        withUserId("user_1", () =>
          withAnonymousId("anon_1", () => {
            const b = propagation.getBaggage(context.active());
            return {
              agentName: b?.getEntry("gen_ai.agent.name")?.value,
              agentId: b?.getEntry("gen_ai.agent.id")?.value,
              conv: b?.getEntry("gen_ai.conversation.id")?.value,
              prev: b?.getEntry("gen_ai.request.previous_response_id")?.value,
              user: b?.getEntry("identity.user_id")?.value,
              anon: b?.getEntry("identity.anonymous_id")?.value,
            };
          }),
        ),
      ),
    );

    expect(seen).toEqual({
      agentName: "support-bot",
      agentId: "agent_1",
      conv: "conv_1",
      prev: "resp_0",
      user: "user_1",
      anon: "anon_1",
    });
  });
});

describe("init() rolls back partial state when setup throws", () => {
  afterEach(async () => {
    await shutdown();
    _resetForTests();
    resetOTelGlobals();
  });

  it("a failing integration leaves no cached provider, so a later init() retries", async () => {
    const boom: Integration = {
      identifier: "boom",
      setupOnce() {
        throw new Error("integration blew up");
      },
    };

    await expect(
      init({
        token: "test-token",
        autoDiscover: false,
        onConflict: "replace",
        advanced: { spanExporter: new InMemorySpanExporter() },
        integrations: [boom],
      }),
    ).rejects.toThrow(/blew up/);

    // State was not committed — the idempotency guard must not hand back a
    // half-configured provider.
    expect(() => getTracerProvider()).toThrow(/init/);

    // A subsequent clean init() succeeds (retry works).
    await initForTest();
    expect(getTracerProvider()).toBeDefined();
  });
});

describe("shutdown() provider ownership + state reset", () => {
  afterEach(async () => {
    await shutdown();
    _resetForTests();
    resetOTelGlobals();
  });

  it("does NOT shut down a caller-supplied provider, and resets state", async () => {
    const provider = new NodeTracerProvider();
    let shutdownCalled = false;
    const orig = provider.shutdown.bind(provider);
    provider.shutdown = async () => {
      shutdownCalled = true;
      return orig();
    };

    await init({
      token: "test-token",
      autoDiscover: false,
      onConflict: "replace",
      tracerProvider: provider,
    });

    await shutdown();

    // Host-owned provider must be left running.
    expect(shutdownCalled).toBe(false);
    // State is cleared so a later init() rebuilds rather than returning a dead one.
    expect(() => getTracerProvider()).toThrow(/init/);
  });

  it("shuts down an init()-created provider and rebuilds on the next init()", async () => {
    await initForTest();
    const first = getTracerProvider();

    await shutdown();
    expect(() => getTracerProvider()).toThrow(/init/);

    await initForTest();
    const second = getTracerProvider();
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
  });
});
