/**
 * LangChain baggage propagation — real ChatAnthropic + Polly.
 *
 * Covers the fix in packages/introspection-node/src/langchain-handler.ts:
 * a single shared IntrospectionCallbackHandler reads OTel baggage from the
 * active context as a fallback for gen_ai.agent.name / gen_ai.agent.id /
 * gen_ai.conversation.id, so users don't need RunnableLambda wrappers or
 * per-call config.metadata threading.
 *
 * No mocks: drives real ChatAnthropic.invoke() against Polly-recorded
 * Anthropic API responses.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from "vitest";
import type { Polly } from "@pollyjs/core";

import { IntrospectionLogs } from "@introspection-sdk/introspection-node/otel";
import { TestSpanExporter } from "../testing";
import {
  setupPolly,
  ensureEnvVarsForReplay,
  pollyEndpoints,
  installTestOTelGlobals,
} from "../polly-setup";

describe("LangChain baggage — shared handler + real ChatAnthropic", () => {
  let exporter: TestSpanExporter | null = null;
  let polly: Polly | null = null;
  let disposeOTel: (() => void) | null = null;

  // One Polly per file: per-beforeEach re-init was overwriting HAR entries
  // across tests so only the last test's recordings survived. Sharing one
  // instance + stopping it once in afterAll means polly persists all
  // entries from all tests in a single merged HAR.
  beforeAll(async () => {
    try {
      await import("@langchain/anthropic");
      await import("@introspection-sdk/introspection-node/langchain");
    } catch {
      console.log("Skipping: LangChain Anthropic package not installed");
      return;
    }

    polly = setupPolly({ recordingName: "langchain-baggage" });
    if (!ensureEnvVarsForReplay(["ANTHROPIC_API_KEY"], "langchain-baggage")) {
      console.log("Skipping: ANTHROPIC_API_KEY missing for record/passthrough");
      await polly.stop();
      polly = null;
      return;
    }
  });

  afterAll(async () => {
    if (polly) {
      await polly.stop();
      polly = null;
    }
  });

  beforeEach(() => {
    if (!polly) return;
    disposeOTel = installTestOTelGlobals();
    exporter = new TestSpanExporter();
  });

  afterEach(() => {
    disposeOTel?.();
    disposeOTel = null;
    exporter = null;
  });

  it("withAgent + withConversation stamp baggage onto the LLM span", async () => {
    if (!exporter) return;

    const { ChatAnthropic } = await import("@langchain/anthropic");
    const { IntrospectionCallbackHandler } =
      await import("@introspection-sdk/introspection-node/langchain");

    // One shared handler for the whole process — the DX we're enabling.
    const handler = new IntrospectionCallbackHandler({
      advanced: { spanExporter: exporter, useSimpleSpanProcessor: true },
    });
    const model = new ChatAnthropic({
      model: "claude-haiku-4-5",
      anthropicApiUrl: pollyEndpoints.anthropic.langchain,
    });
    const introspect = new IntrospectionLogs({ token: "test-token" });

    const CONV_ID = "lc-baggage-conv-test";
    await introspect.withAgent("researcher", "researcher-1", () =>
      introspect.withConversation(CONV_ID, undefined, async () => {
        await model.invoke("Say hello in one word.", { callbacks: [handler] });
      }),
    );

    await handler.forceFlush();
    const spans = exporter.getFinishedSpans();
    const chatSpan = spans.find(
      (s) => s.attributes["gen_ai.operation.name"] === "chat",
    );
    expect(chatSpan).toBeDefined();
    expect(chatSpan?.attributes["gen_ai.agent.name"]).toBe("researcher");
    expect(chatSpan?.attributes["gen_ai.agent.id"]).toBe("researcher-1");
    expect(chatSpan?.attributes["gen_ai.conversation.id"]).toBe(CONV_ID);

    await handler.shutdown();
  });

  it("parallel withAgent calls under one shared handler keep distinct baggage per branch", async () => {
    if (!exporter) return;

    const { ChatAnthropic } = await import("@langchain/anthropic");
    const { IntrospectionCallbackHandler } =
      await import("@introspection-sdk/introspection-node/langchain");

    const handler = new IntrospectionCallbackHandler({
      advanced: { spanExporter: exporter, useSimpleSpanProcessor: true },
    });
    const model = new ChatAnthropic({
      model: "claude-haiku-4-5",
      anthropicApiUrl: pollyEndpoints.anthropic.langchain,
    });
    const introspect = new IntrospectionLogs({ token: "test-token" });

    async function run(agentId: string, convId: string, prompt: string) {
      return introspect.withAgent("researcher", agentId, () =>
        introspect.withConversation(convId, undefined, async () => {
          // Yield to let the other branch interleave — proves AsyncLocalStorage
          // forks baggage per branch rather than relying on call ordering.
          await new Promise((r) => setImmediate(r));
          await model.invoke(prompt, { callbacks: [handler] });
        }),
      );
    }

    await Promise.all([
      run("researcher-primes", "lc-conv-primes", "Say primes in one word."),
      run("researcher-fib", "lc-conv-fib", "Say fibonacci in one word."),
    ]);

    await handler.forceFlush();
    const chatSpans = exporter
      .getFinishedSpans()
      .filter((s) => s.attributes["gen_ai.operation.name"] === "chat");
    expect(chatSpans).toHaveLength(2);

    const primes = chatSpans.find(
      (s) => s.attributes["gen_ai.agent.id"] === "researcher-primes",
    );
    const fib = chatSpans.find(
      (s) => s.attributes["gen_ai.agent.id"] === "researcher-fib",
    );
    expect(primes?.attributes["gen_ai.conversation.id"]).toBe("lc-conv-primes");
    expect(fib?.attributes["gen_ai.conversation.id"]).toBe("lc-conv-fib");

    await handler.shutdown();
  });
});
