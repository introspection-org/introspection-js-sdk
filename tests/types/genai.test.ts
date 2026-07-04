/**
 * Unit tests for the shared GenAI semconv types in `@introspection-sdk/types`.
 *
 * These tests pin the {@link toAttributes} mapping (camelCase ↔ dotted OTel
 * attribute names) and the JSON serialization of object-valued fields.
 */

import { describe, expect, it } from "vitest";
import {
  GenAi,
  GenAiSpanName,
  IntrospectionAttr,
  providerCostAttributes,
  toAttributes,
  type GenAiAttributes,
  type InputMessage,
  type OutputMessage,
  type ToolDefinition,
} from "../../packages/introspection-types/src";

describe("toAttributes", () => {
  it("maps every documented camelCase field to its OTel key", () => {
    const inputMessages: InputMessage[] = [
      { role: "user", parts: [{ type: "text", content: "hi" }] },
    ];
    const outputMessages: OutputMessage[] = [
      {
        role: "assistant",
        parts: [{ type: "text", content: "hello" }],
        finish_reason: "stop",
      },
    ];
    const toolDefinitions: ToolDefinition[] = [
      { name: "shell", description: "run a command" },
    ];

    const attrs: GenAiAttributes = {
      requestModel: "claude-sonnet-4-6",
      providerName: "anthropic",
      operationName: "chat",
      toolDefinitions,
      inputMessages,
      outputMessages,
      systemInstructions: [{ type: "text", content: "Be concise." }],
      responseId: "resp_123",
      responseModel: "claude-sonnet-4-6",
      finishReasons: ["stop"],
      inputTokens: 10,
      outputTokens: 5,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 50,
      costUsd: 0.0012,
    };

    const result = toAttributes(attrs);

    expect(result).toMatchObject({
      "gen_ai.request.model": "claude-sonnet-4-6",
      "gen_ai.provider.name": "anthropic",
      "gen_ai.operation.name": "chat",
      "gen_ai.response.id": "resp_123",
      "gen_ai.response.model": "claude-sonnet-4-6",
      "gen_ai.usage.input_tokens": 10,
      "gen_ai.usage.output_tokens": 5,
      "gen_ai.usage.cache_creation.input_tokens": 0,
      "gen_ai.usage.cache_read.input_tokens": 50,
      "gen_ai.cost.usd": 0.0012,
    });

    expect(JSON.parse(String(result["gen_ai.input.messages"]))).toEqual(
      inputMessages,
    );
    expect(JSON.parse(String(result["gen_ai.output.messages"]))).toEqual(
      outputMessages,
    );
    expect(JSON.parse(String(result["gen_ai.tool.definitions"]))).toEqual(
      toolDefinitions,
    );
    expect(result["gen_ai.response.finish_reasons"]).toEqual(["stop"]);
    expect(JSON.parse(String(result["gen_ai.system_instructions"]))).toEqual([
      { type: "text", content: "Be concise." },
    ]);
  });

  it("omits undefined fields", () => {
    const result = toAttributes({ requestModel: "gpt-5" });
    expect(result).toEqual({ "gen_ai.request.model": "gpt-5" });
  });

  it("strips null and undefined from object payloads before JSON.stringify", () => {
    const result = toAttributes({
      toolDefinitions: [
        {
          name: "shell",
          description: undefined,
          parameters: { type: "object", required: null },
        },
      ],
    });
    const parsed = JSON.parse(String(result["gen_ai.tool.definitions"]));
    expect(parsed).toEqual([{ name: "shell", parameters: { type: "object" } }]);
  });

  it("emits the legacy gen_ai.system field when explicitly set", () => {
    const result = toAttributes({ system: "anthropic" });
    expect(result).toEqual({ "gen_ai.system": "anthropic" });
  });
});

describe("GenAi attribute-name constants", () => {
  it("matches the OTel semconv dotted keys", () => {
    expect(GenAi.CONVERSATION_ID).toBe("gen_ai.conversation.id");
    expect(GenAi.AGENT_ID).toBe("gen_ai.agent.id");
    expect(GenAi.AGENT_NAME).toBe("gen_ai.agent.name");
    expect(GenAi.OPERATION_NAME).toBe("gen_ai.operation.name");
    expect(GenAi.PROVIDER_NAME).toBe("gen_ai.provider.name");
    expect(GenAi.REQUEST_MODEL).toBe("gen_ai.request.model");
    expect(GenAi.RESPONSE_MODEL).toBe("gen_ai.response.model");
    expect(GenAi.RESPONSE_ID).toBe("gen_ai.response.id");
    expect(GenAi.RESPONSE_FINISH_REASONS).toBe(
      "gen_ai.response.finish_reasons",
    );
    expect(GenAi.USAGE_INPUT_TOKENS).toBe("gen_ai.usage.input_tokens");
    expect(GenAi.USAGE_OUTPUT_TOKENS).toBe("gen_ai.usage.output_tokens");
    expect(GenAi.USAGE_CACHE_READ_INPUT_TOKENS).toBe(
      "gen_ai.usage.cache_read.input_tokens",
    );
    expect(GenAi.USAGE_CACHE_CREATION_INPUT_TOKENS).toBe(
      "gen_ai.usage.cache_creation.input_tokens",
    );
    expect(GenAi.COST_USD).toBe("gen_ai.cost.usd");
    expect(GenAi.INPUT_MESSAGES).toBe("gen_ai.input.messages");
    expect(GenAi.OUTPUT_MESSAGES).toBe("gen_ai.output.messages");
    expect(GenAi.SYSTEM_INSTRUCTIONS).toBe("gen_ai.system_instructions");
    expect(GenAi.TOOL_DEFINITIONS).toBe("gen_ai.tool.definitions");
    expect(GenAi.TOOL_NAME).toBe("gen_ai.tool.name");
    expect(GenAi.TOOL_TYPE).toBe("gen_ai.tool.type");
    expect(GenAi.TOOL_CALL_ID).toBe("gen_ai.tool.call.id");
    expect(GenAi.TOOL_CALL_ARGUMENTS).toBe("gen_ai.tool.call.arguments");
    expect(GenAi.TOOL_CALL_RESULT).toBe("gen_ai.tool.call.result");
  });
});

describe("GenAiSpanName", () => {
  it("builds the documented span names", () => {
    expect(GenAiSpanName.chat("anthropic")).toBe("chat anthropic");
    expect(GenAiSpanName.executeTool("shell")).toBe("execute_tool shell");
    expect(GenAiSpanName.invokeAgent("Support")).toBe("invoke_agent Support");
  });
});

describe("providerCostAttributes", () => {
  it("extracts all three attributes from an OpenRouter-style usage block", () => {
    const attrs = providerCostAttributes({
      prompt_tokens: 100,
      completion_tokens: 50,
      cost: 0.95,
      cost_details: { upstream_inference_cost: 0.9 },
      completion_tokens_details: { reasoning_tokens: 42 },
    });

    expect(attrs).toEqual({
      [IntrospectionAttr.LLM_COST_USD]: 0.95,
      [IntrospectionAttr.LLM_UPSTREAM_COST_USD]: 0.9,
      [GenAi.USAGE_REASONING_TOKENS]: 42,
    });
  });

  it("uses the documented attribute names", () => {
    expect(IntrospectionAttr.LLM_COST_USD).toBe("introspection.llm.cost_usd");
    expect(IntrospectionAttr.LLM_UPSTREAM_COST_USD).toBe(
      "introspection.llm.upstream_cost_usd",
    );
    expect(GenAi.USAGE_REASONING_TOKENS).toBe("gen_ai.usage.reasoning_tokens");
  });

  it("keeps a zero cost (free-tier calls are still provider-reported)", () => {
    expect(providerCostAttributes({ cost: 0 })).toEqual({
      [IntrospectionAttr.LLM_COST_USD]: 0,
    });
  });

  it("extracts each field independently when the others are absent", () => {
    expect(providerCostAttributes({ cost: 0.5 })).toEqual({
      [IntrospectionAttr.LLM_COST_USD]: 0.5,
    });
    expect(
      providerCostAttributes({
        cost_details: { upstream_inference_cost: 0.25 },
      }),
    ).toEqual({ [IntrospectionAttr.LLM_UPSTREAM_COST_USD]: 0.25 });
    expect(
      providerCostAttributes({
        completion_tokens_details: { reasoning_tokens: 7 },
      }),
    ).toEqual({ [GenAi.USAGE_REASONING_TOKENS]: 7 });
  });

  it("emits nothing when the cost fields are absent", () => {
    expect(
      providerCostAttributes({ prompt_tokens: 10, completion_tokens: 5 }),
    ).toEqual({});
    expect(providerCostAttributes({})).toEqual({});
  });

  it("emits nothing for a missing or non-object usage payload", () => {
    expect(providerCostAttributes(undefined)).toEqual({});
    expect(providerCostAttributes(null)).toEqual({});
    expect(providerCostAttributes("usage")).toEqual({});
    expect(providerCostAttributes(42)).toEqual({});
  });

  it("skips non-numeric and non-finite values safely", () => {
    expect(
      providerCostAttributes({
        cost: "0.95",
        cost_details: { upstream_inference_cost: "0.9" },
        completion_tokens_details: { reasoning_tokens: "42" },
      }),
    ).toEqual({});
    expect(
      providerCostAttributes({
        cost: Number.NaN,
        cost_details: { upstream_inference_cost: Number.POSITIVE_INFINITY },
        completion_tokens_details: { reasoning_tokens: Number.NaN },
      }),
    ).toEqual({});
  });

  it("skips malformed detail blocks without throwing", () => {
    expect(
      providerCostAttributes({
        cost: 0.1,
        cost_details: "not-an-object",
        completion_tokens_details: null,
      }),
    ).toEqual({ [IntrospectionAttr.LLM_COST_USD]: 0.1 });
    expect(
      providerCostAttributes({
        cost_details: {},
        completion_tokens_details: {},
      }),
    ).toEqual({});
  });
});
