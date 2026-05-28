/**
 * Smoke coverage for IntrospectionLogs — exercises the methods that the
 * old IntrospectionClient covered indirectly through baggage tests, plus
 * the previously-untouched setters/getters/reset paths.
 *
 * Doesn't assert on emitted log payloads (the OTLP exporter is fire-and-
 * forget); the assertions are limited to baggage propagation and
 * instance-state mutation.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { context, propagation } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CBaggagePropagator } from "@opentelemetry/core";

import { IntrospectionLogs } from "@introspection-sdk/introspection-node/otel";

describe("IntrospectionLogs", () => {
  let logs: IntrospectionLogs;

  beforeEach(() => {
    context.setGlobalContextManager(
      new AsyncLocalStorageContextManager().enable(),
    );
    propagation.setGlobalPropagator(new W3CBaggagePropagator());
    logs = new IntrospectionLogs({ token: "test-token" });
  });

  afterEach(async () => {
    await logs.shutdown();
    context.disable();
    propagation.disable();
  });

  it("track / feedback / identify fire without throwing", () => {
    logs.track("clicked", { x: 1 });
    logs.feedback("thumbs_up", { comments: "great" });
    logs.identify("user_1", { email: "a@b.com" }, "anon_x", "evt_1");
    expect(logs.getAnonymousId()).toBe("anon_x");
  });

  it("setUserId / setAnonymousId update instance state, reset clears it", () => {
    logs.setUserId("u1");
    logs.setAnonymousId("a1");
    expect(logs.getAnonymousId()).toBe("a1");
    logs.reset();
    expect(logs.getAnonymousId()).toBeUndefined();
  });

  it("withUserId / withAnonymousId / withBaggage push baggage in scope", async () => {
    await logs.withUserId("u_42", async () => {
      const bag = propagation.getBaggage(context.active());
      expect(bag?.getEntry("identity.user_id")?.value).toBe("u_42");
    });
    await logs.withAnonymousId("anon", async () => {
      const bag = propagation.getBaggage(context.active());
      expect(bag?.getEntry("identity.anonymous_id")?.value).toBe("anon");
    });
    await logs.withBaggage({ foo: "bar" }, async () => {
      const bag = propagation.getBaggage(context.active());
      expect(bag?.getEntry("foo")?.value).toBe("bar");
    });
  });

  it("withAgent attaches agent baggage; withConversation attaches conv baggage", async () => {
    await logs.withAgent("researcher", "r1", async () => {
      const bag = propagation.getBaggage(context.active());
      expect(bag?.getEntry("gen_ai.agent.name")?.value).toBe("researcher");
      expect(bag?.getEntry("gen_ai.agent.id")?.value).toBe("r1");
    });
    await logs.withConversation("conv1", "msg1", async () => {
      const bag = propagation.getBaggage(context.active());
      expect(bag?.getEntry("gen_ai.conversation.id")?.value).toBe("conv1");
      expect(bag?.getEntry("gen_ai.request.previous_response_id")?.value).toBe(
        "msg1",
      );
    });
  });

  it("flush resolves without throwing", async () => {
    await expect(logs.flush()).resolves.toBeUndefined();
  });
});
