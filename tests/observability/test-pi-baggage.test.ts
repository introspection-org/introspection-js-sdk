/**
 * Pi Agent SDK baggage propagation — real Pi Agent + Polly.
 *
 * Pi reads baggage via the same path the other instrumentors do: the
 * IntrospectionSpanProcessor merges OTel baggage into span attributes
 * at onEnd. Pi calls the real Anthropic Node SDK under the hood, which
 * Polly's node-http adapter intercepts — no mocks here.
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
  IntrospectionPiInstrumentor,
  IntrospectionSpanProcessor,
} from "@introspection-sdk/introspection-node/otel";
import { TestSpanExporter, IncrementalIdGenerator } from "../testing";
import {
  setupPolly,
  ensureEnvVarsForReplay,
  pollyEndpoints,
  installTestOTelGlobals,
} from "../polly-setup";

describe("Pi Agent SDK baggage — real Agent against Polly-recorded Anthropic", () => {
  let exporter: TestSpanExporter | null = null;
  let provider: NodeTracerProvider | null = null;
  let instrumentor: IntrospectionPiInstrumentor | null = null;
  let polly: Polly | null = null;
  let disposeOTel: (() => void) | null = null;

  // One Polly per file — see test-langchain-baggage.test.ts for the rationale.
  beforeAll(async () => {
    try {
      await import("@mariozechner/pi-agent-core");
      await import("@mariozechner/pi-ai");
    } catch {
      console.log("Skipping: @mariozechner/pi-agent-core not installed");
      return;
    }

    polly = setupPolly({ recordingName: "pi-baggage" });
    if (!ensureEnvVarsForReplay(["ANTHROPIC_API_KEY"], "pi-baggage")) {
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
    instrumentor = new IntrospectionPiInstrumentor();
  });

  afterEach(async () => {
    if (instrumentor) {
      instrumentor.stop();
      instrumentor = null;
    }
    if (provider) {
      await provider.forceFlush();
      await provider.shutdown();
      provider = null;
    }
    disposeOTel?.();
    disposeOTel = null;
    exporter = null;
  });

  async function makeAgent(systemPrompt = "Answer in one word.") {
    const { Agent } = await import("@mariozechner/pi-agent-core");
    const { getModel } = await import("@mariozechner/pi-ai");
    // Force baseUrl so the request URL is deterministic across record/replay,
    // independent of any ANTHROPIC_BASE_URL leaking in from the host env.
    const model = {
      ...getModel("anthropic", "claude-haiku-4-5"),
      baseUrl: pollyEndpoints.anthropic.node,
    };
    return new Agent({
      initialState: {
        model,
        systemPrompt,
        tools: [],
      },
    });
  }

  it("withAgent + withConversation override the AgentMeta defaults", async () => {
    if (!exporter || !provider || !instrumentor) return;

    const agent = await makeAgent();
    instrumentor.instrument(agent, {
      agentName: "default-agent",
      agentId: "default-id",
      conversationId: "default-conv",
    });

    const introspect = new IntrospectionLogs({ token: "test-token" });
    const CONV_ID = "pi-baggage-conv-test";

    await introspect.withAgent("researcher", "researcher-1", () =>
      introspect.withConversation(CONV_ID, undefined, () =>
        agent.prompt("Say primes."),
      ),
    );

    await provider.forceFlush();
    const spans = exporter
      .getFinishedSpans()
      .filter((s) => s.attributes["gen_ai.operation.name"] === "chat");
    expect(spans.length).toBeGreaterThan(0);
    const chatSpan = spans[0];
    // Baggage wins over the AgentMeta constructor values.
    expect(chatSpan.attributes["gen_ai.agent.name"]).toBe("researcher");
    expect(chatSpan.attributes["gen_ai.agent.id"]).toBe("researcher-1");
    expect(chatSpan.attributes["gen_ai.conversation.id"]).toBe(CONV_ID);
  });

  it("falls back to AgentMeta constructor values when no baggage is set", async () => {
    if (!exporter || !provider || !instrumentor) return;

    const agent = await makeAgent();
    instrumentor.instrument(agent, {
      agentName: "default-agent",
      agentId: "default-id",
      conversationId: "default-conv",
    });

    // No withAgent / withConversation wrappers — span-processor sees no
    // baggage, so attributes fall back to the AgentMeta passed at
    // instrument() time.
    await agent.prompt("Say fibonacci.");

    await provider.forceFlush();
    const spans = exporter
      .getFinishedSpans()
      .filter((s) => s.attributes["gen_ai.operation.name"] === "chat");
    expect(spans.length).toBeGreaterThan(0);
    const chatSpan = spans[0];
    expect(chatSpan.attributes["gen_ai.agent.name"]).toBe("default-agent");
    expect(chatSpan.attributes["gen_ai.agent.id"]).toBe("default-id");
    expect(chatSpan.attributes["gen_ai.conversation.id"]).toBe("default-conv");
  });

  it("parallel agents under one shared instrumentor keep distinct baggage per branch", async () => {
    if (!exporter || !provider || !instrumentor) return;

    // Single shared instrumentor — instrument both agents with neutral
    // defaults, then have each branch override identity via withAgent +
    // withConversation. Mirrors examples/pi/pi-subagents-baggage.ts.
    const primesAgent = await makeAgent();
    const fibAgent = await makeAgent();
    instrumentor.instrument(primesAgent, {
      agentName: "default-agent",
      agentId: "default-id",
      conversationId: "default-conv",
    });
    instrumentor.instrument(fibAgent, {
      agentName: "default-agent",
      agentId: "default-id",
      conversationId: "default-conv",
    });

    const introspect = new IntrospectionLogs({ token: "test-token" });

    async function run(
      agent: Awaited<ReturnType<typeof makeAgent>>,
      agentId: string,
      convId: string,
      prompt: string,
    ) {
      return introspect.withAgent("researcher", agentId, () =>
        introspect.withConversation(convId, undefined, async () => {
          // Yield to let branches interleave — proves AsyncLocalStorage
          // forks baggage per branch independently of call ordering.
          await new Promise((r) => setImmediate(r));
          await agent.prompt(prompt);
        }),
      );
    }

    await Promise.all([
      run(primesAgent, "researcher-primes", "pi-conv-primes", "Say primes."),
      run(fibAgent, "researcher-fib", "pi-conv-fib", "Say fibonacci."),
    ]);

    await provider.forceFlush();
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
    expect(primes?.attributes["gen_ai.conversation.id"]).toBe("pi-conv-primes");
    expect(fib?.attributes["gen_ai.conversation.id"]).toBe("pi-conv-fib");
  });
});
