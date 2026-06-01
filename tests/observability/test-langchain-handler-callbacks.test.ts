/**
 * Callback-path coverage for IntrospectionCallbackHandler — drives the
 * chat/llm/chain/tool start+end callbacks and all three error handlers directly
 * with constructed LangChain payloads. No Polly, no mocks: spans land in a real
 * InMemorySpanExporter (SimpleSpanProcessor exports on end). Real end-to-end
 * LangChain runs are covered by the Polly-backed test-langchain*.test.ts files.
 */
import { describe, expect, it } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  InMemorySpanExporter,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";

import { IntrospectionCallbackHandler } from "../../packages/introspection-node/src/otel/langchain-handler";

function makeHandler() {
  const exporter = new InMemorySpanExporter();
  const handler = new IntrospectionCallbackHandler({
    serviceName: "lc-callbacks",
    advanced: { spanExporter: exporter, useSimpleSpanProcessor: true },
  });
  return { handler, exporter };
}

// Minimal BaseMessage stand-ins (the handler reads `_getType()` + `content`).
const msg = (type: string, content: unknown, extra: object = {}) =>
  ({ _getType: () => type, content, ...extra }) as never;

const chatLlm = {
  id: ["langchain", "chat_models", "anthropic", "ChatAnthropic"],
  kwargs: { model: "claude-haiku-4-5" },
} as never;

const byName = (spans: ReadableSpan[], name: string) =>
  spans.find((s) => s.name === name);

describe("IntrospectionCallbackHandler callbacks", () => {
  it("traces a chain → chat-model → tool run with rich attributes", () => {
    const { handler, exporter } = makeHandler();

    handler.handleChainStart(
      { id: ["x", "AgentExecutor"] } as never,
      {},
      "chain-1",
      undefined,
      undefined,
      { "gen_ai.conversation.id": "conv-1" },
      "agent",
      undefined,
    );

    handler.handleChatModelStart(
      chatLlm,
      [
        [
          msg("system", "Be terse."),
          msg("human", "Weather in NYC?"),
          msg("ai", "", {
            tool_calls: [
              { name: "get_weather", id: "tc1", args: { city: "NYC" } },
            ],
          }),
          msg("tool", "sunny", { tool_call_id: "tc1" }),
        ],
      ],
      "llm-1",
      "chain-1",
      {
        invocation_params: {
          model: "claude-haiku-4-5",
          temperature: 0.5,
          tools: [
            {
              type: "function",
              function: {
                name: "get_weather",
                description: "d",
                parameters: {},
              },
            },
          ],
        },
      },
      undefined,
      { "gen_ai.conversation.id": "conv-1" },
    );

    handler.handleLLMEnd(
      {
        generations: [
          [
            {
              text: "It is sunny.",
              message: {
                kwargs: {
                  additional_kwargs: {
                    tool_calls: [
                      {
                        id: "tc1",
                        function: { name: "get_weather", arguments: "{}" },
                      },
                    ],
                  },
                },
              },
            } as never,
          ],
        ],
        llmOutput: { tokenUsage: { promptTokens: 20, completionTokens: 6 } },
      } as never,
      "llm-1",
    );

    handler.handleToolStart(
      { id: ["x", "get_weather"] } as never,
      '{"city":"NYC"}',
      "tool-1",
      "chain-1",
      undefined,
      { "gen_ai.conversation.id": "conv-1" },
      "get_weather",
    );
    handler.handleToolEnd({ temp: 22 }, "tool-1");

    handler.handleChainEnd({}, "chain-1");

    const spans = exporter.getFinishedSpans();
    const chat = byName(spans, "chat claude-haiku-4-5");
    expect(chat, "chat span").toBeDefined();
    expect(chat!.attributes["gen_ai.request.model"]).toBe("claude-haiku-4-5");
    expect(chat!.attributes["gen_ai.conversation.id"]).toBe("conv-1");
    expect(chat!.attributes["openinference.span.kind"]).toBe("LLM");
    expect(String(chat!.attributes["gen_ai.input.messages"])).toContain(
      "Weather in NYC?",
    );
    expect(String(chat!.attributes["gen_ai.system_instructions"])).toContain(
      "Be terse.",
    );
    expect(String(chat!.attributes["gen_ai.tool.definitions"])).toContain(
      "get_weather",
    );
    expect(chat!.attributes["gen_ai.request.temperature"]).toBe(0.5);

    const tool = byName(spans, "get_weather");
    expect(tool, "tool span").toBeDefined();
    expect(tool!.attributes["gen_ai.tool.name"]).toBe("get_weather");
    expect(tool!.attributes["gen_ai.tool.input"]).toBe('{"city":"NYC"}');
    expect(tool!.attributes["gen_ai.tool.output"]).toBe('{"temp":22}');

    expect(byName(spans, "agent"), "chain span").toBeDefined();
  });

  it("covers the plain (non-chat) LLM start/end path", () => {
    const { handler, exporter } = makeHandler();
    handler.handleLLMStart(
      { id: ["x", "OpenAI"], kwargs: { model: "gpt-4o" } } as never,
      ["hello"],
      "llm-2",
    );
    handler.handleLLMEnd(
      { generations: [[{ text: "hi" } as never]] } as never,
      "llm-2",
    );
    const chat = byName(exporter.getFinishedSpans(), "chat gpt-4o");
    expect(chat).toBeDefined();
    expect(String(chat!.attributes["gen_ai.input.messages"])).toContain(
      "hello",
    );
  });

  it("records ERROR status on llm / tool / chain errors", () => {
    const { handler, exporter } = makeHandler();

    handler.handleLLMStart({ id: ["x", "OpenAI"] } as never, ["p"], "e-llm");
    handler.handleLLMError(new Error("llm boom"), "e-llm");

    handler.handleToolStart({ id: ["x", "t"] } as never, "in", "e-tool");
    handler.handleToolError(new Error("tool boom"), "e-tool");

    handler.handleChainStart({ id: ["x", "c"] } as never, {}, "e-chain");
    handler.handleChainError(new Error("chain boom"), "e-chain");

    const errored = exporter
      .getFinishedSpans()
      .filter((s) => s.status.code === SpanStatusCode.ERROR);
    expect(errored).toHaveLength(3);
    expect(
      errored.map((s) => s.attributes["exception.message"]).sort(),
    ).toEqual(["chain boom", "llm boom", "tool boom"]);
  });

  it("no-ops end/error callbacks for unknown runIds", () => {
    const { handler } = makeHandler();
    expect(() =>
      handler.handleLLMEnd({ generations: [] } as never, "nope"),
    ).not.toThrow();
    expect(() => handler.handleToolEnd("x", "nope")).not.toThrow();
    expect(() => handler.handleChainEnd({}, "nope")).not.toThrow();
    expect(() => handler.handleLLMError(new Error("x"), "nope")).not.toThrow();
  });
});
