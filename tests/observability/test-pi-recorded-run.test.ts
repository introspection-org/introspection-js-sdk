/**
 * Pi run spans and GenAI client metrics — real Agent, Polly cassette.
 *
 * `IntrospectionPiInstrumentor` deliberately does not open run spans (hosts
 * that already own a turn span would get duplicates). This file drives the
 * low-level composition instead — `instrumentAgent({ runSpans: true })` plus
 * `instrumentStream({ getParentContext })` — and checks the shape the
 * platform actually aggregates on: one trace per run, and metrics whose
 * values come from a real provider response rather than a fixture.
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
import { SpanKind, SpanStatusCode, type Tracer } from "@opentelemetry/api";
import type { Polly } from "@pollyjs/core";
import type { Agent, StreamFn } from "@earendil-works/pi-agent-core";

import {
  instrumentAgent,
  instrumentStream,
  type AgentInstrumentation,
  type AgentMeta,
} from "@introspection-sdk/introspection-pi";
import {
  setupPolly,
  ensureEnvVarsForReplay,
  installTestOTelGlobals,
} from "../polly-setup";
import {
  makeAgent,
  makeWeatherTool,
  piTracing,
  recordingMeter,
  type MetricRecord,
  type PiTracing,
  type WeatherTool,
} from "./pi-fixtures";

const RECORDING = "pi-run";
const SYSTEM_PROMPT =
  "You are a weather assistant. Always call get_weather before answering. Answer in one short sentence.";
const PROMPT = "What is the weather in Paris?";
const META: AgentMeta = {
  conversationId: "pi-run-conv",
  agentId: "pi-run-agent",
  agentName: "Weather",
};

describe("Pi run spans + metrics — real Agent against a Polly-recorded Anthropic call", () => {
  let polly: Polly | null = null;
  let tracing: PiTracing | null = null;
  let disposeOTel: (() => void) | null = null;
  let instrumentation: AgentInstrumentation | null = null;
  let weather: WeatherTool | null = null;

  beforeAll(async () => {
    polly = setupPolly({ recordingName: RECORDING });
    if (!ensureEnvVarsForReplay(["ANTHROPIC_API_KEY"], RECORDING)) {
      await polly.stop();
      polly = null;
    }
  });

  afterAll(async () => {
    await polly?.stop();
    polly = null;
  });

  beforeEach(() => {
    if (!polly) return;
    disposeOTel = installTestOTelGlobals();
    tracing = piTracing();
  });

  afterEach(async () => {
    instrumentation?.stop();
    instrumentation = null;
    if (tracing) {
      await tracing.provider.forceFlush();
      await tracing.provider.shutdown();
      tracing = null;
    }
    disposeOTel?.();
    disposeOTel = null;
    weather = null;
  });

  /** Wire the run-span composition documented on `InstrumentAgentOptions`. */
  function wire(
    agent: Agent,
    tracer: Tracer,
    meter?: ReturnType<typeof recordingMeter>["meter"],
  ) {
    const handle = instrumentAgent(agent, {
      tracer,
      meta: META,
      meter,
      runSpans: true,
    });
    const key = "streamFunction" in agent ? "streamFunction" : "streamFn";
    const instrumentable = agent as unknown as Record<
      "streamFunction" | "streamFn",
      StreamFn
    >;
    instrumentable[key] = instrumentStream(instrumentable[key], {
      tracer,
      meta: META,
      meter,
      getParentContext: () => handle.getRunContext(),
    });
    return handle;
  }

  async function runOnce(meter?: ReturnType<typeof recordingMeter>["meter"]) {
    weather = await makeWeatherTool();
    const agent = await makeAgent({
      systemPrompt: SYSTEM_PROMPT,
      tools: [weather.tool],
    });
    instrumentation = wire(
      agent,
      tracing!.provider.getTracer("pi-test"),
      meter,
    );
    await agent.prompt(PROMPT);
    await tracing!.provider.forceFlush();
  }

  it("opens one invoke_agent span that parents every chat and tool span", async () => {
    if (!polly) return;
    await runOnce();

    const runs = tracing!.spansFor("invoke_agent");
    expect(runs).toHaveLength(1);
    const run = runs[0]!;

    expect(run.name).toBe("invoke_agent Weather");
    expect(run.kind).toBe(SpanKind.INTERNAL);
    expect(run.status.code).toBe(SpanStatusCode.UNSET);
    expect(run.attributes["gen_ai.conversation.id"]).toBe("pi-run-conv");
    expect(run.attributes["gen_ai.agent.id"]).toBe("pi-run-agent");
    expect(run.parentSpanContext).toBeUndefined();
    expect(run.attributes["gen_ai.response.finish_reasons"]).toEqual(["stop"]);

    const children = [
      ...tracing!.spansFor("chat"),
      ...tracing!.spansFor("execute_tool"),
    ];
    expect(children.length).toBeGreaterThanOrEqual(3);
    for (const child of children) {
      expect(child.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
      expect(child.spanContext().traceId).toBe(run.spanContext().traceId);
    }
  });

  it("keeps usage off the run span so trace-wide sums do not double-count", async () => {
    if (!polly) return;
    await runOnce();

    const run = tracing!.spansFor("invoke_agent")[0]!;
    for (const key of Object.keys(run.attributes)) {
      expect(key.startsWith("gen_ai.usage.")).toBe(false);
    }
    // The tokens live on the chat spans, once each.
    const chats = tracing!.spansFor("chat");
    expect(
      chats.every(
        (c) => (c.attributes["gen_ai.usage.output_tokens"] as number) > 0,
      ),
    ).toBe(true);
  });

  it("records the GenAI client metrics from the real response", async () => {
    if (!polly) return;
    const { meter, records } = recordingMeter();
    await runOnce(meter);

    const chatCount = tracing!.spansFor("chat").length;
    const tokens = records["gen_ai.client.token.usage"] ?? [];
    const byType = (type: string) =>
      tokens.filter((r) => r.attributes?.["gen_ai.token.type"] === type);

    expect(byType("input")).toHaveLength(chatCount);
    expect(byType("output")).toHaveLength(chatCount);
    for (const record of tokens) {
      expect(record.value).toBeGreaterThan(0);
      expect(record.attributes).toMatchObject({
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "anthropic",
        "server.address": "api.anthropic.com",
      });
    }

    expectPositive(records["gen_ai.client.operation.duration"], chatCount);
    expectPositive(
      records["gen_ai.client.operation.time_to_first_chunk"],
      chatCount,
    );
    expectPositive(records["gen_ai.execute_tool.duration"], 1);
    expectPositive(records["gen_ai.invoke_agent.duration"], 1);

    expect(
      records["gen_ai.execute_tool.duration"]?.[0]?.attributes,
    ).toMatchObject({
      "gen_ai.tool.name": "get_weather",
      "gen_ai.tool.type": "function",
    });
    expect(
      records["gen_ai.invoke_agent.duration"]?.[0]?.attributes,
    ).toMatchObject({ "gen_ai.agent.name": "Weather" });

    // No error path was taken, so no measurement carries error.type.
    for (const series of Object.values(records)) {
      for (const record of series) {
        expect(record.attributes?.["error.type"]).toBeUndefined();
      }
    }
  });
});

function expectPositive(series: MetricRecord[] | undefined, count: number) {
  expect(series).toHaveLength(count);
  for (const record of series!) {
    expect(record.value).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(record.value)).toBe(true);
  }
}
