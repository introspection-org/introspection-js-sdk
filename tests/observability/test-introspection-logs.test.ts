/**
 * Coverage for IntrospectionLogs — baggage propagation, and the attributes
 * that end up on the emitted records.
 *
 * The OTLP exporter is fire-and-forget and the provider is built inside the
 * constructor, so there is no seam to inject an in-memory exporter through.
 * `captureEmits` swaps the internal logger for a collector instead; that is
 * one level below the wire, but it is the level at which the attribute
 * contract is decided.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { context, propagation } from "@opentelemetry/api";
import type { LogAttributes } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CBaggagePropagator } from "@opentelemetry/core";

import { IntrospectionLogs } from "@introspection-sdk/introspection-node/otel";

function captureEmits(logs: IntrospectionLogs): LogAttributes[] {
  const records: LogAttributes[] = [];
  (
    logs as unknown as { otelLogger: { emit: (r: unknown) => void } }
  ).otelLogger = {
    emit: (record) => {
      records.push((record as { attributes: LogAttributes }).attributes);
    },
  };
  return records;
}

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
  });

  it("puts the identified user on the identify record itself", () => {
    const records = captureEmits(logs);
    logs.identify("user_1", { plan: "pro" }, "anon_x", "evt_1");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      "event.name": "identify",
      "event.id": "evt_1",
      "identity.user.id": "user_1",
      "identity.anonymous.id": "anon_x",
      "context.traits.plan": "pro",
    });
  });

  it("does not leak an identified user onto later events", () => {
    const records = captureEmits(logs);
    logs.identify("user_1");
    logs.track("clicked");
    expect(records[1]["identity.user.id"]).toBeUndefined();
  });

  it("keeps two concurrent identities apart", async () => {
    const records = captureEmits(logs);
    // One IntrospectionLogs instance serves the whole process. Two requests
    // in flight at once must not see each other's user.
    await Promise.all([
      logs.withUserId("user_a", async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        logs.track("a_event");
      }),
      logs.withUserId("user_b", async () => {
        logs.track("b_event");
      }),
    ]);
    const byEvent = Object.fromEntries(
      records.map((r) => [r["event.name"], r["identity.user.id"]]),
    );
    expect(byEvent).toEqual({ a_event: "user_a", b_event: "user_b" });
  });

  it("reports the anonymous id scoped on the current context", async () => {
    expect(logs.getAnonymousId()).toBeUndefined();
    await logs.withAnonymousId("anon_1", async () => {
      expect(logs.getAnonymousId()).toBe("anon_1");
    });
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
