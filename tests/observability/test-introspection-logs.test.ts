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

import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { IntrospectionLogs } from "@introspection-sdk/introspection-node/otel";
// Internal helper, imported by path rather than widening the public barrel.
import { exporterHeaders } from "../../packages/introspection-node/src/utils.js";

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

describe("IntrospectionLogs exports through the real pipeline", () => {
  // `captureEmits` below swaps the logger and stops one level above the
  // exporter. This test goes through the whole batch/export path with the
  // `logExporter` seam -- the same hook Python, Rust, and the browser client
  // expose -- so the contract is asserted where it actually leaves the SDK.
  it("puts the shared contract keys on the exported record", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const logs = new IntrospectionLogs({
      token: "intro_test",
      logExporter: exporter,
      flushInterval: 1,
    });
    logs.track("Button Clicked", { buttonId: "submit", count: 3 });
    logs.feedback("thumbs_up", { comments: "great" });
    logs.identify("user_42", { plan: "pro" });
    await logs.flush();

    const records = exporter.getFinishedLogRecords();
    expect(records).toHaveLength(3);
    const byName = Object.fromEntries(
      records.map((r) => [r.attributes["event.name"], r]),
    );

    expect(byName["Button Clicked"]?.attributes).toMatchObject({
      "properties.buttonId": "submit",
      "properties.count": 3,
    });
    expect(byName["Button Clicked"]?.attributes["event.id"]).toMatch(
      /^intro_event_[0-9a-f]+-[0-9a-z]+$/,
    );
    expect(byName["introspection.feedback"]?.attributes).toMatchObject({
      "properties.name": "thumbs_up",
      "properties.comments": "great",
    });
    expect(byName["identify"]?.attributes).toMatchObject({
      "identity.user.id": "user_42",
      "context.traits.plan": "pro",
    });
    expect(byName["identify"]?.severityText).toBe("INFO");

    await logs.shutdown();
  });
});

describe("instrumentation scope and resource", () => {
  it("names the SDK, and leaves the language to the resource", async () => {
    // The language is not
    // encoded in it on purpose: `telemetry.sdk.language` on the resource is
    // the semconv-designated place, and it is set for free. Asserted here
    // because the scope name's brevity depends on it being present.
    const exporter = new InMemoryLogRecordExporter();
    const logs = new IntrospectionLogs({
      token: "intro_test",
      logExporter: exporter,
      flushInterval: 1,
    });
    logs.track("E");
    await logs.flush();
    const [record] = exporter.getFinishedLogRecords();

    expect(record!.instrumentationScope.name).toBe("introspection-sdk");
    expect(record!.instrumentationScope.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(record!.resource.attributes["telemetry.sdk.language"]).toBe(
      "nodejs",
    );

    await logs.shutdown();
  });
});

describe("exporter headers", () => {
  it("identifies the SDK and release, like Python and Rust do", () => {
    const headers = exporterHeaders("intro_test");
    expect(headers["User-Agent"]).toMatch(/^introspection-sdk\/\d+\.\d+\.\d+/);
    expect(headers["Authorization"]).toBe("Bearer intro_test");
  });

  it("lets caller headers override", () => {
    const headers = exporterHeaders("t", { "User-Agent": "my-app/1.0" });
    expect(headers["User-Agent"]).toBe("my-app/1.0");
  });

  it("sends no Authorization at all rather than a bare Bearer", () => {
    // A tokenless client is either warned about (logs) or running a
    // caller-supplied exporter carrying its own auth (spans). Neither
    // wants `Bearer ` with nothing after it on the wire.
    const headers = exporterHeaders(undefined);
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["User-Agent"]).toMatch(/^introspection-sdk\//);
  });
});

describe("property and trait coercion", () => {
  // A telemetry call must never silently lose what the caller handed it. The
  // previous inline branch kept only object/string/number/boolean and emitted
  // no attribute at all for anything else.
  it("carries every value kind, degrading rather than dropping", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const logs = new IntrospectionLogs({
      token: "intro_test",
      logExporter: exporter,
      flushInterval: 1,
    });
    logs.track("E", {
      str: "s",
      num: 1.5,
      bool: false,
      obj: { a: 1 },
      arr: [1, 2],
      big: 9007199254740993n,
      nothing: null,
      missing: undefined,
    });
    await logs.flush();
    const attrs = exporter.getFinishedLogRecords()[0]!.attributes;

    expect(attrs["properties.str"]).toBe("s");
    expect(attrs["properties.num"]).toBe(1.5);
    expect(attrs["properties.bool"]).toBe(false);
    expect(attrs["properties.obj"]).toBe('{"a":1}');
    expect(attrs["properties.arr"]).toBe("[1,2]");
    // bigint cannot go through JSON.stringify -- it throws -- and used to be
    // dropped outright.
    expect(attrs["properties.big"]).toBe("9007199254740993");
    // null / undefined stay dropped: absent is the honest representation.
    expect("properties.nothing" in attrs).toBe(false);
    expect("properties.missing" in attrs).toBe(false);

    await logs.shutdown();
  });

  it("does not throw on a circular object", async () => {
    const exporter = new InMemoryLogRecordExporter();
    const logs = new IntrospectionLogs({
      token: "intro_test",
      logExporter: exporter,
      flushInterval: 1,
    });
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    expect(() => logs.track("E", { circular })).not.toThrow();
    await logs.flush();
    expect(
      exporter.getFinishedLogRecords()[0]!.attributes["properties.circular"],
    ).toBeDefined();
    await logs.shutdown();
  });
});

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

  it("keeps the feedback name when an extra property is also called name", () => {
    const records = captureEmits(logs);
    // `name` is the positional argument. Spreading the extras last let a
    // caller's own `name` property silently replace it, so the event went
    // out labelled as something the caller never asked for.
    logs.feedback("thumbs_up", {
      comments: "great",
      name: "not the feedback name",
    } as Parameters<typeof logs.feedback>[1]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      "event.name": "introspection.feedback",
      "properties.name": "thumbs_up",
      "properties.comments": "great",
    });
  });

  it("carries an empty comment rather than dropping it", () => {
    const records = captureEmits(logs);
    // `""` is a comment the caller supplied. A truthiness check dropped it,
    // so the same call produced a `properties.comments` key in the Python
    // and no key at all here.
    logs.feedback("thumbs_down", { comments: "" });
    expect(records[0]).toMatchObject({ "properties.comments": "" });
  });

  it("reports the anonymous id scoped on the current context", async () => {
    expect(logs.getAnonymousId()).toBeUndefined();
    await logs.withAnonymousId("anon_1", async () => {
      expect(logs.getAnonymousId()).toBe("anon_1");
    });
    expect(logs.getAnonymousId()).toBeUndefined();
  });

  it("reports the user id scoped on the current context", async () => {
    // The anonymous-id getter existed alone; callers
    // expose both halves of the identity they read from the same baggage.
    expect(logs.getUserId()).toBeUndefined();
    await logs.withUserId("u_42", async () => {
      expect(logs.getUserId()).toBe("u_42");
    });
    expect(logs.getUserId()).toBeUndefined();
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
