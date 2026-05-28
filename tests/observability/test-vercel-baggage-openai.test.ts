/**
 * Vercel AI SDK baggage propagation — real generateText + Polly, native pathway.
 *
 * The AI SDK emits gen_ai.* and ai.* attributes natively when callers pass
 * `experimental_telemetry: { isEnabled: true }`. IntrospectionSpanProcessor
 * (registered globally by setupTracing or manually here) runs
 * convertVercelAIToGenAI on those spans at onEnd, filling gen_ai.input.messages,
 * gen_ai.output.messages, gen_ai.tool.definitions, etc.
 *
 * That means there's no integration class to instantiate per-call — users
 * just call setupTracing() once and the AI SDK is covered for any provider.
 * This test proves baggage from withAgent / withConversation reaches the
 * resulting spans for both single calls and parallel ones.
 *
 * No mocks: drives real generateText() with @ai-sdk/openai against Polly-
 * recorded OpenAI API responses.
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
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import type { Polly } from "@pollyjs/core";

import {
  IntrospectionLogs,
  IntrospectionSpanProcessor,
} from "@introspection-sdk/introspection-node/otel";
import { TestSpanExporter, IncrementalIdGenerator } from "../testing";
import {
  setupPolly,
  ensureEnvVarsForReplay,
  pollyEndpoints,
  installTestOTelGlobals,
} from "../polly-setup";

describe("Vercel AI SDK baggage — native telemetry (OpenAI)", () => {
  let exporter: TestSpanExporter | null = null;
  let provider: NodeTracerProvider | null = null;
  let polly: Polly | null = null;
  let disposeOTel: (() => void) | null = null;

  beforeAll(async () => {
    try {
      await import("ai");
      await import("@ai-sdk/openai");
    } catch {
      console.log("Skipping: ai / @ai-sdk/openai not installed");
      return;
    }

    polly = setupPolly({ recordingName: "vercel-baggage-openai" });
    if (!ensureEnvVarsForReplay(["OPENAI_API_KEY"], "vercel-baggage-openai")) {
      console.log("Skipping: OPENAI_API_KEY missing for record/passthrough");
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
    // Register our processor on the GLOBAL tracer the AI SDK uses when
    // `experimental_telemetry: { isEnabled: true }` is set without a custom
    // tracer. The processor's onEnd runs convertVercelAIToGenAI + baggage
    // merge for any ai.* spans the SDK produces.
    provider = new NodeTracerProvider({
      idGenerator: new IncrementalIdGenerator(),
      spanProcessors: [
        new IntrospectionSpanProcessor({
          token: "test-token",
          advanced: { spanExporter: exporter, useSimpleSpanProcessor: true },
        }),
      ],
    });
    provider.register();
  });

  afterEach(async () => {
    if (provider) {
      await provider.forceFlush();
      await provider.shutdown();
      provider = null;
    }
    disposeOTel?.();
    disposeOTel = null;
    exporter = null;
  });

  it("withAgent + withConversation stamp baggage on AI SDK step spans", async () => {
    if (!exporter || !provider) return;

    const { generateText } = await import("ai");
    const { createOpenAI } = await import("@ai-sdk/openai");
    const openai = createOpenAI({ baseURL: pollyEndpoints.openai.aiSdk });
    const introspect = new IntrospectionLogs({ token: "test-token" });

    const CONV_ID = "vc-baggage-conv-test";
    await introspect.withAgent("researcher", "researcher-1", () =>
      introspect.withConversation(CONV_ID, undefined, () =>
        generateText({
          model: openai("gpt-5-nano"),
          prompt: "Say hello in one word.",
          experimental_telemetry: { isEnabled: true },
        }),
      ),
    );

    await provider.forceFlush();
    const chatSpans = exporter
      .getFinishedSpans()
      .filter((s) => s.attributes["gen_ai.operation.name"] === "chat");
    expect(chatSpans.length).toBeGreaterThan(0);
    const chat = chatSpans[0];
    expect(chat.attributes["gen_ai.agent.name"]).toBe("researcher");
    expect(chat.attributes["gen_ai.agent.id"]).toBe("researcher-1");
    expect(chat.attributes["gen_ai.conversation.id"]).toBe(CONV_ID);
  });

  it("parallel generateText calls keep distinct baggage per branch", async () => {
    if (!exporter || !provider) return;

    const { generateText } = await import("ai");
    const { createOpenAI } = await import("@ai-sdk/openai");
    const openai = createOpenAI({ baseURL: pollyEndpoints.openai.aiSdk });
    const introspect = new IntrospectionLogs({ token: "test-token" });

    async function run(agentId: string, convId: string, prompt: string) {
      return introspect.withAgent("researcher", agentId, () =>
        introspect.withConversation(convId, undefined, async () => {
          await new Promise((r) => setImmediate(r));
          await generateText({
            model: openai("gpt-5-nano"),
            prompt,
            experimental_telemetry: { isEnabled: true },
          });
        }),
      );
    }

    await Promise.all([
      run("researcher-primes", "vc-conv-primes", "Say primes in one word."),
      run("researcher-fib", "vc-conv-fib", "Say fibonacci in one word."),
    ]);

    await provider.forceFlush();
    const chatSpans = exporter
      .getFinishedSpans()
      .filter((s) => s.attributes["gen_ai.operation.name"] === "chat");
    expect(chatSpans.length).toBe(2);

    const primes = chatSpans.find(
      (s) => s.attributes["gen_ai.agent.id"] === "researcher-primes",
    );
    const fib = chatSpans.find(
      (s) => s.attributes["gen_ai.agent.id"] === "researcher-fib",
    );
    expect(primes?.attributes["gen_ai.conversation.id"]).toBe("vc-conv-primes");
    expect(fib?.attributes["gen_ai.conversation.id"]).toBe("vc-conv-fib");
  });
});
