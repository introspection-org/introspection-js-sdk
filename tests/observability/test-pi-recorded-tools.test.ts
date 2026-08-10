/**
 * Pi tool-calling — real Agent, real Anthropic tool_use response, Polly cassette.
 *
 * The tool loop is where instrumentation is easiest to get subtly wrong: the
 * `execute_tool` span has to open on pi's `tool_execution_start`, stay active
 * while the tool body runs, close with the real result, and the follow-up
 * chat span has to carry the tool result back in its input messages. Mocked
 * agent events can't prove any of that ordering — a recorded run can.
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
import { SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import type { Polly } from "@pollyjs/core";

import { IntrospectionPiInstrumentor } from "@introspection-sdk/introspection-node/otel/pi";
import type {
  InputMessage,
  OutputMessage,
  ToolDefinition,
} from "@introspection-sdk/introspection-pi";
import {
  setupPolly,
  ensureEnvVarsForReplay,
  installTestOTelGlobals,
} from "../polly-setup";
import {
  jsonAttr,
  makeAgent,
  makeWeatherTool,
  piTracing,
  type PiTracing,
  type WeatherTool,
} from "./pi-fixtures";

const RECORDING = "pi-tools";
const SYSTEM_PROMPT =
  "You are a weather assistant. Always call get_weather before answering. Answer in one short sentence.";
const PROMPT = "What is the weather in Tokyo?";

describe("Pi tool calling — real Agent against a Polly-recorded Anthropic call", () => {
  let polly: Polly | null = null;
  let tracing: PiTracing | null = null;
  let instrumentor: IntrospectionPiInstrumentor | null = null;
  let disposeOTel: (() => void) | null = null;
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
    instrumentor = new IntrospectionPiInstrumentor();
  });

  afterEach(async () => {
    instrumentor?.stop();
    instrumentor = null;
    if (tracing) {
      await tracing.provider.forceFlush();
      await tracing.provider.shutdown();
      tracing = null;
    }
    disposeOTel?.();
    disposeOTel = null;
    weather = null;
  });

  async function runToolTurn() {
    weather = await makeWeatherTool();
    const agent = await makeAgent({
      systemPrompt: SYSTEM_PROMPT,
      tools: [weather.tool],
    });
    instrumentor!.instrument(agent, {
      conversationId: "pi-tools-conv",
      agentId: "pi-tools-agent",
      agentName: "Weather",
    });
    await agent.prompt(PROMPT);
    await tracing!.provider.forceFlush();
    return {
      chats: tracing!.spansFor("chat"),
      tools: tracing!.spansFor("execute_tool"),
    };
  }

  it("runs the tool for real and emits one execute_tool span per call", async () => {
    if (!polly) return;
    const { tools } = await runToolTurn();

    // The tool body actually executed — this is not a replayed transcript of
    // pi's events, it is pi's loop calling our function.
    expect(weather!.calls).toEqual(["Tokyo"]);

    expect(tools).toHaveLength(1);
    const span = tools[0]!;
    expect(span.name).toBe("execute_tool get_weather");
    expect(span.kind).toBe(SpanKind.INTERNAL);
    expect(span.status.code).toBe(SpanStatusCode.UNSET);

    expect(span.attributes["gen_ai.operation.name"]).toBe("execute_tool");
    expect(span.attributes["gen_ai.tool.name"]).toBe("get_weather");
    expect(span.attributes["gen_ai.tool.type"]).toBe("function");
    expect(span.attributes["gen_ai.tool.call.id"]).toEqual(
      expect.stringMatching(/^toolu_/),
    );
    expect(span.attributes["gen_ai.tool.description"]).toEqual(
      expect.stringContaining("current weather"),
    );
    expect(span.attributes["gen_ai.conversation.id"]).toBe("pi-tools-conv");
    expect(span.attributes["gen_ai.agent.name"]).toBe("Weather");

    // Arguments come from the model; the result comes from our tool.
    expect(
      jsonAttr<{ city: string }>(span, "gen_ai.tool.call.arguments"),
    ).toEqual({
      city: "Tokyo",
    });
    expect(span.attributes["gen_ai.tool.call.result"]).toEqual(
      expect.stringContaining("Clear, 25°C"),
    );
  });

  it("advertises the tool schema on every chat span in the loop", async () => {
    if (!polly) return;
    const { chats } = await runToolTurn();
    expect(chats.length).toBeGreaterThanOrEqual(2);

    for (const chat of chats) {
      const defs = jsonAttr<ToolDefinition[]>(chat, "gen_ai.tool.definitions");
      expect(defs).toHaveLength(1);
      expect(defs[0]!.type).toBe("function");
      expect(defs[0]!.name).toBe("get_weather");
      // The real typebox schema, not a hand-written stand-in.
      expect(defs[0]!.parameters).toMatchObject({
        type: "object",
        properties: { city: { type: "string" } },
      });
    }
  });

  it("threads the tool call and its result through the message attributes", async () => {
    if (!polly) return;
    const { chats } = await runToolTurn();
    const [first, second] = chats;

    // Turn 1 output: the model asked for the tool.
    const output = jsonAttr<OutputMessage[]>(first!, "gen_ai.output.messages");
    expect(output[0]!.finish_reason).toBe("tool_call");
    const call = output[0]!.parts.find((p) => p.type === "tool_call");
    expect(call).toMatchObject({
      type: "tool_call",
      name: "get_weather",
      arguments: { city: "Tokyo" },
    });

    // Turn 2 input: the same call id comes back as a tool_call_response.
    const input = jsonAttr<InputMessage[]>(second!, "gen_ai.input.messages");
    const response = input
      .flatMap((m) => m.parts)
      .find((p) => p.type === "tool_call_response");
    expect(response).toBeDefined();
    expect((response as { id: string }).id).toBe((call as { id: string }).id);
    expect(JSON.stringify(response)).toContain("Clear, 25°C");

    // …and the final answer is a plain completion.
    const final = jsonAttr<OutputMessage[]>(second!, "gen_ai.output.messages");
    expect(final[0]!.finish_reason).toBe("stop");
  });

  it("keeps the execute_tool span active for the duration of the tool body", async () => {
    if (!polly) return;
    let seenInsideTool: string | undefined;

    weather = await makeWeatherTool();
    const inner = weather.tool.execute;
    weather.tool.execute = async (...args) => {
      // Anything the tool does — subprocesses, HTTP, MCP — should be able to
      // parent onto the tool span via the ambient context.
      seenInsideTool = trace.getActiveSpan()?.spanContext().spanId;
      return inner(...args);
    };

    const agent = await makeAgent({
      systemPrompt: SYSTEM_PROMPT,
      tools: [weather.tool],
    });
    instrumentor!.instrument(agent, {
      conversationId: "pi-tools-conv",
      agentId: "pi-tools-agent",
      agentName: "Weather",
    });
    await agent.prompt(PROMPT);
    await tracing!.provider.forceFlush();

    const toolSpan = tracing!.spansFor("execute_tool")[0];
    expect(toolSpan).toBeDefined();
    expect(seenInsideTool).toBe(toolSpan!.spanContext().spanId);
  });
});
