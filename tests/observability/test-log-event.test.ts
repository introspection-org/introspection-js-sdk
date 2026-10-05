/**
 * `logEvent` — the custom-event primitive `track` is an alias of — on the
 * Node `IntrospectionLogs`, the module-level `init()` proxy, and the browser
 * client. OTel-only: records go to an in-memory log exporter through the
 * `logExporter` seam, nothing crosses a network boundary.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SeverityNumber } from "@opentelemetry/api-logs";
import {
  InMemoryLogRecordExporter,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import {
  IntrospectionLogs,
  RESERVED_EVENT_NAME_PREFIXES,
  _resetForTests,
  init,
  logEvent,
  resetInstalledForTests,
  track,
} from "@introspection-sdk/introspection-node/otel";
import { IntrospectionClient } from "@introspection-sdk/introspection-browser";
import { installTestOTelGlobals } from "../polly-setup";

interface Emitter {
  logEvent: IntrospectionLogs["logEvent"];
  track: IntrospectionLogs["track"];
  withUserId<T>(userId: string, callback: () => T | Promise<T>): Promise<T>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

const surfaces: Array<
  [string, (exporter: InMemoryLogRecordExporter) => Emitter]
> = [
  [
    "IntrospectionLogs (node)",
    (exporter) =>
      new IntrospectionLogs({
        token: "intro_test",
        logExporter: exporter,
        flushInterval: 1,
      }),
  ],
  [
    "IntrospectionClient (browser)",
    (exporter) =>
      new IntrospectionClient({
        token: "intro_test",
        advanced: { logExporter: exporter, flushInterval: 1 },
      }),
  ],
];

describe.each(surfaces)("%s.logEvent", (_label, make) => {
  let dispose: () => void;
  let exporter: InMemoryLogRecordExporter;
  let client: Emitter;

  beforeEach(() => {
    dispose = installTestOTelGlobals();
    exporter = new InMemoryLogRecordExporter();
    client = make(exporter);
  });

  afterEach(async () => {
    await client.shutdown();
    dispose();
    vi.restoreAllMocks();
  });

  async function emitted(): Promise<ReadableLogRecord[]> {
    await client.flush();
    return exporter.getFinishedLogRecords();
  }

  it("emits the custom name with attributes under properties.*", async () => {
    client.logEvent("ark.feed.entry", {
      entry_id: "e_1",
      score: 0.9,
      tags: ["a", "b"],
      skipped: undefined,
    });
    const [record] = await emitted();
    expect(record!.attributes).toMatchObject({
      "event.name": "ark.feed.entry",
      "properties.entry_id": "e_1",
      "properties.score": 0.9,
      "properties.tags": '["a","b"]',
    });
    expect(record!.attributes).not.toHaveProperty("properties.skipped");
    expect(record!.attributes["event.id"]).toMatch(/^intro_event_/);
    expect(record!.severityNumber).toBe(SeverityNumber.INFO);
    expect(record!.severityText).toBe("INFO");
  });

  it("passes a caller-supplied event id through for dedup", async () => {
    client.logEvent(
      "ark.feed.entry",
      { entry_id: "e_1" },
      {
        eventId: "feed-entry:e_1",
      },
    );
    client.logEvent(
      "ark.feed.entry",
      { entry_id: "e_1" },
      {
        eventId: "feed-entry:e_1",
      },
    );
    const records = await emitted();
    expect(records.map((r) => r.attributes["event.id"])).toEqual([
      "feed-entry:e_1",
      "feed-entry:e_1",
    ]);
  });

  it("honours timestamp and severity", async () => {
    const at = new Date("2026-01-02T03:04:05.678Z");
    client.logEvent("ark.sync.failed", undefined, {
      timestamp: at,
      severity: "ERROR",
    });
    const [record] = await emitted();
    expect(record!.hrTime).toEqual([Math.floor(at.getTime() / 1000), 678e6]);
    expect(record!.severityNumber).toBe(SeverityNumber.ERROR);
    expect(record!.severityText).toBe("ERROR");
  });

  it("lets the identity option override the context, field by field", async () => {
    await client.withUserId("ctx_user", async () => {
      client.logEvent("ark.a", undefined, {
        identity: { userId: "explicit_user", anonymousId: "anon_1" },
      });
      client.logEvent("ark.b", undefined, {
        identity: { anonymousId: "anon_2" },
      });
    });
    const [a, b] = await emitted();
    expect(a!.attributes["identity.user.id"]).toBe("explicit_user");
    expect(a!.attributes["identity.anonymous.id"]).toBe("anon_1");
    // An omitted field still falls back to the scoped identity.
    expect(b!.attributes["identity.user.id"]).toBe("ctx_user");
    expect(b!.attributes["identity.anonymous.id"]).toBe("anon_2");
  });

  it.each([
    "introspection.track",
    "introspection.feedback",
    "gen_ai.client.inference",
  ])("rejects the reserved name %s", async (name) => {
    expect(() => client.logEvent(name)).toThrow(/reserved/);
    expect(await emitted()).toHaveLength(0);
  });

  it("rejects an empty name", () => {
    expect(() => client.logEvent("")).toThrow(/non-empty/);
  });

  it("allows names that merely contain a reserved word", async () => {
    client.logEvent("my.introspection.event");
    client.logEvent("gen_ai_usage");
    expect(await emitted()).toHaveLength(2);
  });

  it("track delegates to logEvent with the same arguments", async () => {
    const spy = vi.spyOn(client, "logEvent");
    client.track("Button Clicked", { buttonId: "submit" }, { eventId: "e1" });
    expect(spy).toHaveBeenCalledWith(
      "Button Clicked",
      { buttonId: "submit" },
      { eventId: "e1" },
    );
    const [record] = await emitted();
    expect(record!.attributes).toMatchObject({
      "event.name": "Button Clicked",
      "event.id": "e1",
      "properties.buttonId": "submit",
    });
  });
});

describe("module-level logEvent", () => {
  let dispose: () => void;

  beforeEach(() => {
    dispose = installTestOTelGlobals();
    _resetForTests();
    resetInstalledForTests();
  });

  afterEach(() => {
    _resetForTests();
    dispose();
  });

  it("names the reserved prefixes", () => {
    expect(RESERVED_EVENT_NAME_PREFIXES).toEqual(["introspection.", "gen_ai."]);
  });

  it("throws before init", () => {
    expect(() => logEvent("ark.feed.entry")).toThrow(/init\(\)/);
  });

  it("routes through the init() client, alongside track", async () => {
    const logExporter = new InMemoryLogRecordExporter();
    await init({
      token: "t",
      autoDiscover: false,
      advanced: {
        spanExporter: new InMemorySpanExporter(),
        logExporter,
        maxBatchSize: 1,
        flushInterval: 1,
      },
    });

    logEvent("ark.feed.entry", { entry_id: "e_1" }, { eventId: "fe:e_1" });
    track("Button Clicked");
    await new Promise((r) => setTimeout(r, 50));

    const names = logExporter
      .getFinishedLogRecords()
      .map((r) => [r.attributes["event.name"], r.attributes["event.id"]]);
    expect(names).toContainEqual(["ark.feed.entry", "fe:e_1"]);
    expect(names.map(([n]) => n)).toContain("Button Clicked");
  });
});
