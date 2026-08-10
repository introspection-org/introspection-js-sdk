/**
 * Tests for the unified `introspection.init()` entry point.
 *
 * Covers three concerns as nested describes:
 *  - the integration loader (run-once + `isAvailable` + `DidNotEnable`),
 *  - `init()` wiring / idempotency / analytics proxies / `conversation()`,
 *  - auto-discovery of the installed frameworks.
 *
 * This is a cross-framework feature, so it lives in its own file rather than
 * under any single framework's test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { context, propagation } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  init,
  _resetForTests,
  track,
  conversation,
  getTracerProvider,
  getClient,
  discoverIntegrations,
  setupIntegrations,
  IntrospectionSpanProcessor,
  resetInstalledForTests,
  DidNotEnable,
  type Integration,
  type IntegrationSetupContext,
} from "@introspection-sdk/introspection-node/otel";
import { TestSpanExporter } from "../testing";
import { installTestOTelGlobals } from "../polly-setup";

function fakeCtx(): IntegrationSetupContext {
  return {
    tracerProvider: new NodeTracerProvider() as never,
    token: "test-token",
    handles: {},
  };
}

describe("introspection.init()", () => {
  let dispose: () => void;

  beforeEach(() => {
    dispose = installTestOTelGlobals();
    _resetForTests();
    resetInstalledForTests();
  });

  afterEach(() => dispose());

  // -------------------------------------------------------------------------
  describe("integration loader", () => {
    it("runs setupOnce exactly once per identifier", async () => {
      const calls: string[] = [];
      const A: Integration = {
        identifier: "a",
        setupOnce: () => {
          calls.push("a");
        },
      };
      const B: Integration = {
        identifier: "b",
        setupOnce: () => {
          calls.push("b");
        },
      };

      const installed = await setupIntegrations([A, B], fakeCtx());
      expect(installed.has("a")).toBe(true);
      expect(installed.has("b")).toBe(true);
      expect(calls).toEqual(["a", "b"]);

      // Second call is a no-op for already-installed identifiers.
      await setupIntegrations([A, B], fakeCtx());
      expect(calls).toEqual(["a", "b"]);
    });

    it("skips integrations whose isAvailable resolves false", async () => {
      const calls: string[] = [];
      const Available: Integration = {
        identifier: "available",
        setupOnce: () => {
          calls.push("available");
        },
      };
      const Missing: Integration = {
        identifier: "missing",
        isAvailable: () => false,
        setupOnce: () => {
          calls.push("missing");
        },
      };

      const installed = await setupIntegrations(
        [Missing, Available],
        fakeCtx(),
      );

      expect(installed.has("available")).toBe(true);
      expect(installed.has("missing")).toBe(false);
      expect(calls).toEqual(["available"]);
    });

    it("swallows DidNotEnable from an integration", async () => {
      const Flaky: Integration = {
        identifier: "flaky",
        setupOnce: () => {
          throw new DidNotEnable("nope");
        },
      };
      const installed = await setupIntegrations([Flaky], fakeCtx());
      expect(installed.has("flaky")).toBe(false);
    });

    it("rethrows unexpected errors from an integration", async () => {
      const Boom: Integration = {
        identifier: "boom",
        setupOnce: () => {
          throw new Error("kaboom");
        },
      };
      await expect(setupIntegrations([Boom], fakeCtx())).rejects.toThrow(
        "kaboom",
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("wiring", () => {
    const exporter = () => new TestSpanExporter();

    it("names its own provider the same service the events use", async () => {
      // The provider only got a resource when a serviceName was supplied, so
      // spans arrived as `unknown_service:node` while the events beside them
      // said `introspection-client`: one process, two services.
      const spans = new InMemorySpanExporter();
      await init({
        token: "t",
        autoDiscover: false,
        advanced: { spanExporter: spans },
      });
      const tracer = getTracerProvider().getTracer("t");
      tracer
        .startSpan("s", {
          attributes: { "gen_ai.request.model": "claude-haiku-4-5" },
        })
        .end();
      await (getTracerProvider() as NodeTracerProvider).forceFlush();

      const [exported] = spans.getFinishedSpans();
      expect(exported!.resource.attributes["service.name"]).toBe(
        "introspection-client",
      );
      // Merged onto the default resource rather than replacing it: that is
      // where `telemetry.sdk.language` comes from.
      expect(exported!.resource.attributes["telemetry.sdk.language"]).toBe(
        "nodejs",
      );
    });

    it("leaves a provider the caller supplied unlabelled", async () => {
      // Defaulting the name must not reach through to someone else's
      // provider: a process that built its own as "checkout-api" would see
      // every LLM span rewritten.
      const spans = new InMemorySpanExporter();
      const own = new NodeTracerProvider({
        resource: resourceFromAttributes({ "service.name": "checkout-api" }),
        spanProcessors: [
          new IntrospectionSpanProcessor({
            token: "t",
            advanced: { spanExporter: spans },
          }),
        ],
      });
      await init({ token: "t", autoDiscover: false, tracerProvider: own });
      own
        .getTracer("t")
        .startSpan("s", {
          attributes: { "gen_ai.request.model": "claude-haiku-4-5" },
        })
        .end();
      await own.forceFlush();

      const [exported] = spans.getFinishedSpans();
      expect(exported!.resource.attributes["service.name"]).toBe(
        "checkout-api",
      );
      await own.shutdown();
    });

    it("is idempotent — repeated calls return the same provider", async () => {
      const p1 = await init({
        token: "t",
        autoDiscover: false,
        advanced: { spanExporter: exporter() },
      });
      const p2 = await init({ token: "t", autoDiscover: false });
      expect(p1).toBe(p2);
      expect(getTracerProvider()).toBe(p1);
    });

    it("collapses concurrent calls onto one provider", async () => {
      // The `state.provider` guard is set only after discovery and
      // integration setup have awaited. Two callers racing both saw it unset,
      // both built a provider and a LoggerProvider with its own batch-export
      // timer, and the second overwrote the first -- leaking the first's
      // exporters with nothing left holding a reference to shut them down.
      const opts = {
        token: "t",
        autoDiscover: false,
        advanced: { spanExporter: exporter() },
      };
      const [p1, p2, p3] = await Promise.all([
        init(opts),
        init(opts),
        init(opts),
      ]);
      expect(p2).toBe(p1);
      expect(p3).toBe(p1);
      expect(getTracerProvider()).toBe(p1);
    });

    it("lets a later call retry after a failed init", async () => {
      // The in-flight promise must be cleared on rejection too, or one bad
      // init() would wedge every later one onto the same failure.
      const boom: Integration = {
        identifier: "boom",
        setupOnce: () => {
          throw new Error("integration exploded");
        },
      };
      await expect(
        init({
          token: "t",
          autoDiscover: false,
          integrations: [boom],
          advanced: { spanExporter: exporter() },
        }),
      ).rejects.toThrow("integration exploded");
      resetInstalledForTests();
      const provider = await init({
        token: "t",
        autoDiscover: false,
        advanced: { spanExporter: exporter() },
      });
      expect(getTracerProvider()).toBe(provider);
    });

    it("requires a token", async () => {
      delete process.env.INTROSPECTION_TOKEN;
      await expect(init({ autoDiscover: false })).rejects.toThrow(/token/);
    });

    it("accepts a custom exporter in place of a token", async () => {
      // init() documents the exemption; the span processor used to enforce a
      // token regardless, so this path threw for tokenless callers.
      delete process.env.INTROSPECTION_TOKEN;
      const provider = await init({
        autoDiscover: false,
        advanced: { spanExporter: exporter() },
      });
      expect(provider).toBeDefined();
      expect(getTracerProvider()).toBe(provider);
    });

    it("analytics proxies throw before init", () => {
      expect(() => track("evt")).toThrow(/init\(\)/);
      expect(() => getClient()).toThrow(/init\(\)/);
      expect(() => getTracerProvider()).toThrow(/init\(\)/);
    });

    it("track works after init", async () => {
      await init({
        token: "t",
        autoDiscover: false,
        advanced: { spanExporter: exporter() },
      });
      expect(() => track("evt", { k: "v" })).not.toThrow();
    });

    it("installs an explicitly requested integration", async () => {
      const seen: IntegrationSetupContext[] = [];
      const Fake: Integration = {
        identifier: "fake_test_integration",
        setupOnce: (ctx) => {
          seen.push(ctx);
        },
      };
      await init({
        token: "t",
        autoDiscover: false,
        integrations: [Fake],
        advanced: { spanExporter: exporter() },
      });
      expect(seen).toHaveLength(1);
      expect(seen[0].tracerProvider).toBeDefined();
    });

    it("conversation() scopes gen_ai.conversation.id onto baggage", async () => {
      await init({
        token: "t",
        autoDiscover: false,
        advanced: { spanExporter: exporter() },
      });

      let captured: string | undefined;
      const returned = await conversation("conv-xyz", (id) => {
        captured = propagation
          .getBaggage(context.active())
          ?.getEntry("gen_ai.conversation.id")?.value;
        return id;
      });

      expect(captured).toBe("conv-xyz");
      expect(returned).toBe("conv-xyz");
    });

    it("conversation() generates an id when none is given", async () => {
      await init({
        token: "t",
        autoDiscover: false,
        advanced: { spanExporter: exporter() },
      });
      const id = await conversation((cid) => cid);
      expect(id).toMatch(/^intro_conv_[0-9a-f]+$/);
    });

    it("conversation() works before init(), unlike the with* helpers", async () => {
      // Minting an id and scoping it is W3C baggage and nothing else: no
      // exporter is involved, so there is nothing for `init()` to supply.
      // Routing it through the global client made this throw, which put the
      // id out of reach of anyone wanting one before telemetry is
      // configured, or to hand to a service that exports on its own.
      let captured: string | undefined;
      const id = await conversation((cid) => {
        captured = propagation
          .getBaggage(context.active())
          ?.getEntry("gen_ai.conversation.id")?.value;
        return cid;
      });
      expect(id).toMatch(/^intro_conv_[0-9a-f]+$/);
      expect(captured).toBe(id);
    });

    it("conversation() leaves the scope when the callback returns", async () => {
      await conversation("conv-scoped", () => undefined);
      expect(
        propagation
          .getBaggage(context.active())
          ?.getEntry("gen_ai.conversation.id")?.value,
      ).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe("auto-discovery", () => {
    it("discovers every installed built-in integration", async () => {
      const ids = (await discoverIntegrations()).map((i) => i.identifier);
      expect(ids).toEqual(expect.arrayContaining(["pi"]));
    });
  });

  // -------------------------------------------------------------------------
  describe("auto-wires every installed framework", () => {
    it("runs each integration's setupOnce and publishes bound handles", async () => {
      // Full auto-discovery: exercises every built-in integration's
      // setupOnce against the shared provider in one call.
      await init({
        token: "test-token",
        serviceName: "init-autowire-test",
        advanced: { spanExporter: new TestSpanExporter() },
      });

      // Instance-based frameworks publish bound handles. Pi's handle is
      // bound when @earendil-works/pi-agent-core is installed, so the
      // accessor must not report the integration as unconfigured.
      const { instrumentPi } =
        await import("@introspection-sdk/introspection-node/otel");
      let message = "";
      try {
        instrumentPi({ streamFn: () => undefined } as never, {} as never);
      } catch (e) {
        message = String(e);
      }
      expect(message).not.toContain("Pi integration not configured");
    });
  });
});
