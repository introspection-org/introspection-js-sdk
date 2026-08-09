/**
 * The browser analytics client's wire contract.
 *
 * `track` / `feedback` / `identify` are OTLP logs on every platform, and the
 * attribute keys have to match what the Node analytics stream emits or the same
 * event lands in two shapes depending on where it was recorded. This file
 * asserts the browser half against a real in-memory log exporter, through the
 * `advanced.logExporter` seam.
 *
 * There is no DOM here, so the `typeof window !== "undefined"` page-context
 * block does not run -- that is deliberate. This is about the contract keys,
 * not the browser-only enrichment.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import { IntrospectionClient } from "@introspection-sdk/introspection-browser";

let exporter: InMemoryLogRecordExporter;
let client: IntrospectionClient;

beforeEach(() => {
  exporter = new InMemoryLogRecordExporter();
  client = new IntrospectionClient({
    token: "intro_test",
    serviceName: "shop-frontend",
    advanced: { logExporter: exporter, flushInterval: 1 },
  });
});

afterEach(async () => {
  await client.shutdown();
});

async function records(): Promise<Record<string, unknown>[]> {
  await client.flush();
  return exporter
    .getFinishedLogRecords()
    .map((r) => r.attributes as Record<string, unknown>);
}

describe("browser analytics emit the shared wire contract", () => {
  it("track: event.name, a generated event.id, and prefixed properties", async () => {
    client.track("Button Clicked", { buttonId: "submit", count: 3 });
    const [record] = await records();
    expect(record["event.name"]).toBe("Button Clicked");
    // Same id format the backend expects everywhere else.
    expect(record["event.id"]).toMatch(/^intro_event_[0-9a-f]+-[0-9a-z]{8}$/);
    expect(record["properties.buttonId"]).toBe("submit");
    expect(record["properties.count"]).toBe(3);
  });

  it("track: honours an explicit event id", async () => {
    client.track("E", undefined, { eventId: "evt-123" });
    const [record] = await records();
    expect(record["event.id"]).toBe("evt-123");
  });

  it("feedback: the reserved event name, with the name as a property", async () => {
    client.feedback("thumbs_up", {
      comments: "great",
      conversationId: "conv_1",
    });
    const [record] = await records();
    expect(record["event.name"]).toBe("introspection.feedback");
    expect(record["properties.name"]).toBe("thumbs_up");
    expect(record["properties.comments"]).toBe("great");
    expect(record["gen_ai.conversation.id"]).toBe("conv_1");
  });

  it("feedback: the positional name survives an extra property of the same name", async () => {
    client.feedback("thumbs_up", {
      name: "not the feedback name",
    } as Parameters<typeof client.feedback>[1]);
    const [record] = await records();
    expect(record["properties.name"]).toBe("thumbs_up");
  });

  it("feedback: carries an empty comment rather than dropping it", async () => {
    client.feedback("thumbs_down", { comments: "" });
    const [record] = await records();
    expect(record["properties.comments"]).toBe("");
  });

  it("reports the identified user, like the Node client", async () => {
    expect(client.getUserId()).toBeUndefined();
    client.identify("user_42");
    expect(client.getUserId()).toBe("user_42");
  });

  it("identify: the reserved event name, the user id, and prefixed traits", async () => {
    client.identify("user_42", { plan: "pro" });
    const [record] = await records();
    expect(record["event.name"]).toBe("identify");
    expect(record["identity.user.id"]).toBe("user_42");
    expect(record["context.traits.plan"]).toBe("pro");
  });

  it("coerces every property kind the same way Node does", async () => {
    client.track("E", { obj: { a: 1 }, big: 9007199254740993n, n: 2 });
    const [record] = await records();
    expect(record["properties.obj"]).toBe('{"a":1}');
    expect(record["properties.big"]).toBe("9007199254740993");
    expect(record["properties.n"]).toBe(2);
  });

  it("shares the SDK scope name and carries its own resource", async () => {
    // The provider used to be constructed with no resource at all, so
    // `service.name` stayed `unknown_service` and the `serviceName` option
    // was accepted and never applied. That mattered more once the scope name
    // became the same string all four SDKs use: `telemetry.sdk.language`
    // ("webjs") and service.name are what identify this surface now.
    client.track("E");
    await client.flush();
    const [record] = exporter.getFinishedLogRecords();

    expect(record!.instrumentationScope.name).toBe("introspection-sdk");
    expect(record!.resource.attributes["service.name"]).toBe("shop-frontend");
    // Present, not a specific value: `@opentelemetry/resources` picks the
    // language through conditional exports, so a real browser bundle reports
    // "webjs" while this suite -- which runs under Node -- sees "nodejs".
    // What matters is that the attribute is there at all, since the scope
    // name no longer distinguishes the surfaces.
    expect(record!.resource.attributes["telemetry.sdk.language"]).toBeTruthy();
  });

  it("emits at severity INFO", async () => {
    client.track("E");
    await client.flush();
    const [emitted] = exporter.getFinishedLogRecords();
    expect(emitted?.severityText).toBe("INFO");
  });
});
