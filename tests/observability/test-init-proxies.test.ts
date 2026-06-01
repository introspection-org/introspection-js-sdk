/**
 * Coverage for the init() baggage proxies (withAgent / withConversation /
 * withUserId / withAnonymousId) and the init() partial-state rollback.
 * No mocks: a real InMemorySpanExporter stands in for the token.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
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

describe("shutdown()", () => {
  afterEach(async () => {
    await shutdown();
    _resetForTests();
    resetOTelGlobals();
  });

  it("shuts down owned providers and clears the init cache", async () => {
    const provider = await init({
      token: "test-token",
      autoDiscover: false,
      onConflict: "replace",
      advanced: { spanExporter: new InMemorySpanExporter() },
    });
    const shutdownSpy = vi.spyOn(provider as NodeTracerProvider, "shutdown");

    await shutdown();

    expect(shutdownSpy).toHaveBeenCalledOnce();
    expect(() => getTracerProvider()).toThrow(/init/);

    await initForTest();
    expect(getTracerProvider()).toBeDefined();
  });

  it("does not shut down caller-owned providers", async () => {
    const provider = new NodeTracerProvider();
    const shutdownSpy = vi.spyOn(provider, "shutdown");

    await init({
      tracerProvider: provider,
      token: "test-token",
      autoDiscover: false,
      onConflict: "replace",
    });
    await shutdown();

    expect(shutdownSpy).not.toHaveBeenCalled();
    expect(() => getTracerProvider()).toThrow(/init/);
  });
});
