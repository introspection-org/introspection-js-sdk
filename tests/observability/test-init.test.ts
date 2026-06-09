/**
 * Tests for the unified `introspection.init()` entry point.
 *
 * Covers four concerns as nested describes:
 *  - the integration loader (run-once + `deactivates` + `DidNotEnable`),
 *  - `init()` wiring / idempotency / analytics proxies / `conversation()`,
 *  - auto-discovery of the installed frameworks,
 *  - the prototype-patch one-liner against the real Anthropic & Gemini SDKs
 *    (recordings-backed, per AGENTS.md).
 *
 * This is a cross-framework feature, so it lives in its own file rather than
 * under any single framework's test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { context, propagation } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  init,
  _resetForTests,
  track,
  conversation,
  getTracerProvider,
  getClient,
  discoverIntegrations,
  setupIntegrations,
  resetInstalledForTests,
  DidNotEnable,
  AnthropicInstrumentor,
  GeminiInstrumentor,
  IntrospectionSpanProcessor,
  type Integration,
  type IntegrationSetupContext,
} from "@introspection-sdk/introspection-node/otel";
import { TestSpanExporter } from "../testing";
import {
  installTestOTelGlobals,
  setupPolly,
  ensureEnvVarsForReplay,
} from "../polly-setup";

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
    it("runs setupOnce once and respects deactivates", async () => {
      const calls: string[] = [];
      const A: Integration = {
        identifier: "a",
        setupOnce: () => calls.push("a"),
      };
      const B: Integration = {
        identifier: "b",
        deactivates: ["a"],
        setupOnce: () => calls.push("b"),
      };

      const installed = await setupIntegrations([A, B], fakeCtx());
      expect(installed.has("b")).toBe(true);
      expect(installed.has("a")).toBe(false); // deactivated by B
      expect(calls).toEqual(["b"]);

      // Second call is a no-op for already-installed identifiers.
      await setupIntegrations([B], fakeCtx());
      expect(calls).toEqual(["b"]);
    });

    it("does not apply deactivates from unavailable integrations", async () => {
      const calls: string[] = [];
      const Available: Integration = {
        identifier: "available",
        setupOnce: () => calls.push("available"),
      };
      const MissingWrapper: Integration = {
        identifier: "missing-wrapper",
        deactivates: ["available"],
        isAvailable: () => false,
        setupOnce: () => calls.push("missing-wrapper"),
      };

      const installed = await setupIntegrations(
        [MissingWrapper, Available],
        fakeCtx(),
      );

      expect(installed.has("available")).toBe(true);
      expect(installed.has("missing-wrapper")).toBe(false);
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

    it("requires a token (or a custom exporter)", async () => {
      delete process.env.INTROSPECTION_TOKEN;
      await expect(init({ autoDiscover: false })).rejects.toThrow(/token/);
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
        setupOnce: (ctx) => seen.push(ctx),
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
  });

  // -------------------------------------------------------------------------
  describe("auto-discovery", () => {
    it("discovers every installed built-in integration", async () => {
      const ids = (await discoverIntegrations()).map((i) => i.identifier);
      expect(ids).toEqual(
        expect.arrayContaining([
          "anthropic",
          "gemini",
          "openai_agents",
          "vercel",
          "claude_agent",
          "langchain",
          "mastra",
          "pi",
        ]),
      );
    });
  });

  // -------------------------------------------------------------------------
  describe("prototype patching (the one-liner)", () => {
    it("AnthropicInstrumentor.instrumentClass traces any client", async () => {
      const polly = setupPolly({ recordingName: "anthropic-thinking-basic" });
      if (
        !ensureEnvVarsForReplay(
          ["ANTHROPIC_API_KEY"],
          "anthropic-thinking-basic",
        )
      ) {
        await polly.stop();
        return;
      }

      const exp = new TestSpanExporter();
      const provider = new NodeTracerProvider({
        spanProcessors: [
          new IntrospectionSpanProcessor({
            token: "test-token",
            advanced: {
              spanExporter: exp,
              useSimpleSpanProcessor: true,
            } as never,
          }),
        ],
      });
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const instrumentor = new AnthropicInstrumentor();
      instrumentor.instrumentClass({
        anthropic: Anthropic,
        tracerProvider: provider,
      });

      try {
        // A client constructed AFTER the class patch is traced with no wiring.
        const client = new Anthropic();
        const response = (await client.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 8000,
          thinking: { type: "enabled", budget_tokens: 5000 },
          messages: [
            { role: "user", content: "What is 2+2? Think step by step." },
          ],
        })) as { content: { type: string }[] };
        expect(response.content.length).toBeGreaterThanOrEqual(1);

        await provider.forceFlush();
        const spans = exp.getFinishedSpans();
        expect(spans.length).toBeGreaterThanOrEqual(1);
        expect(spans[0].attributes["gen_ai.request.model"]).toBe(
          "claude-sonnet-4-6",
        );
        expect(spans[0].attributes["gen_ai.conversation.id"]).toBeDefined();
      } finally {
        instrumentor.uninstrument();
        await provider.shutdown();
        await polly.stop();
      }
    });

    it("GeminiInstrumentor.instrumentClass traces any client", async () => {
      const polly = setupPolly({ recordingName: "gemini-thinking-basic" });
      if (
        !ensureEnvVarsForReplay(["GEMINI_API_KEY"], "gemini-thinking-basic")
      ) {
        await polly.stop();
        return;
      }

      const exp = new TestSpanExporter();
      const provider = new NodeTracerProvider({
        spanProcessors: [
          new IntrospectionSpanProcessor({
            token: "test-token",
            advanced: {
              spanExporter: exp,
              useSimpleSpanProcessor: true,
            } as never,
          }),
        ],
      });
      const genai = await import("@google/genai");
      const instrumentor = new GeminiInstrumentor();
      instrumentor.instrumentClass({ genai, tracerProvider: provider });

      try {
        const client = new genai.GoogleGenAI({
          apiKey: process.env.GEMINI_API_KEY,
        });
        const response = await client.models.generateContent({
          model: "gemini-2.5-flash",
          contents: "What is 2+2? Think step by step.",
          config: {
            thinkingConfig: { thinkingBudget: 2048, includeThoughts: true },
          },
        });
        expect(response.candidates?.length).toBeGreaterThanOrEqual(1);

        await provider.forceFlush();
        const spans = exp.getFinishedSpans();
        expect(spans.length).toBeGreaterThanOrEqual(1);
        expect(spans[0].attributes["gen_ai.request.model"]).toBe(
          "gemini-2.5-flash",
        );
        expect(spans[0].attributes["gen_ai.provider.name"]).toBe("gemini");
      } finally {
        instrumentor.uninstrument();
        await provider.shutdown();
        await polly.stop();
      }
    });
  });

  // -------------------------------------------------------------------------
  describe("auto-wires every installed framework", () => {
    it("runs each integration's setupOnce and publishes bound handles", async () => {
      // Gemini's prototype patch is process-global; restore it afterward.
      // (Anthropic is deactivated by the LangChain integration below.)
      const genai = await import("@google/genai");
      const claudeSdk = await import("@anthropic-ai/claude-agent-sdk");
      const origGemini = (genai.Models.prototype as Record<string, unknown>)
        .generateContentInternal;

      try {
        // Full auto-discovery: exercises every built-in integration's
        // setupOnce against the shared provider in one call.
        await init({
          token: "test-token",
          serviceName: "init-autowire-test",
          advanced: { spanExporter: new TestSpanExporter() },
        });

        // Gemini is patched globally (it is not deactivated).
        expect(
          (genai.Models.prototype as Record<string, unknown>)
            .generateContentInternal,
        ).not.toBe(origGemini);

        // Instance/config-based frameworks publish bound handles.
        const {
          getLangchainHandler,
          getMastraExporter,
          instrumentClaudeAgent,
        } = await import("@introspection-sdk/introspection-node/otel");
        expect(getLangchainHandler()).toBeDefined();
        expect(getMastraExporter()).toBeDefined();

        const traced = instrumentClaudeAgent(claudeSdk);
        expect(typeof traced.query).toBe("function");
        await traced.shutdown();
      } finally {
        (
          genai.Models.prototype as Record<string, unknown>
        ).generateContentInternal = origGemini;
      }
    });

    it("LangChain integration deactivates the Anthropic prototype patch", async () => {
      // When LangChain drives Anthropic, the handler already traces the call,
      // so the prototype patch must be skipped to avoid double-tracing.
      const Anthropic = (await import("@anthropic-ai/sdk")).default;
      const orig = Anthropic.Messages.prototype.create;
      try {
        await init({
          token: "test-token",
          advanced: { spanExporter: new TestSpanExporter() },
        });
        expect(Anthropic.Messages.prototype.create).toBe(orig);
      } finally {
        Anthropic.Messages.prototype.create = orig;
      }
    });
  });
});
