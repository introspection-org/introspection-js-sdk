import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Polly } from "@pollyjs/core";
import { TestSpanExporter, simplifySpansForSnapshot } from "../testing";
import { setupPolly, ensureEnvVarsForReplay } from "../polly-setup";

describe("LangChain First-Party Handler Tests", () => {
  let exporter: TestSpanExporter | null = null;
  let polly: Polly | null = null;

  beforeEach(async () => {
    try {
      await import("@langchain/openai");
      await import("@introspection-sdk/introspection-node/langchain");
    } catch {
      console.log(
        "Skipping: LangChain packages not installed (@langchain/openai, @langchain/core)",
      );
      return;
    }

    polly = setupPolly({ recordingName: "langchain-handler" });

    if (!ensureEnvVarsForReplay(["OPENAI_API_KEY"], "langchain-handler")) {
      console.log(
        "Skipping: Required env vars not set for record/passthrough mode",
      );
      await polly.stop();
      polly = null;
      return;
    }

    exporter = new TestSpanExporter();
  });

  afterEach(async () => {
    if (polly) {
      await polly.stop();
      polly = null;
    }
    exporter = null;
  });

  it("should capture LangChain chat completion with gen_ai attributes via first-party handler", async () => {
    if (!exporter) {
      return;
    }

    let ChatOpenAI, IntrospectionCallbackHandler;
    try {
      ({ ChatOpenAI } = await import("@langchain/openai"));
      ({ IntrospectionCallbackHandler } =
        await import("@introspection-sdk/introspection-node/langchain"));
    } catch {
      console.log("Skipping: required LangChain packages not installed");
      return;
    }

    const handler = new IntrospectionCallbackHandler({
      advanced: {
        spanExporter: exporter,
        useSimpleSpanProcessor: true,
      },
    });

    const model = new ChatOpenAI({
      modelName: "gpt-5-nano",
    });

    const response = await model.invoke("Say hello in one word.", {
      callbacks: [handler],
    });

    expect(response.content).toBeDefined();

    await handler.forceFlush();
    const spans = exporter.getFinishedSpans();

    expect(spans.length).toBeGreaterThan(0);

    const simplified = simplifySpansForSnapshot(spans, {
      normalize: true,
    });

    // The LLM span has full gen_ai.* attributes
    const chatSpan = simplified.find(
      (s) => s.attributes["gen_ai.operation.name"] === "chat",
    );
    expect(chatSpan).toBeDefined();
    expect(chatSpan).toMatchInlineSnapshot(
      {
        trace_id: expect.any(String),
        span_id: expect.any(String),
      },
      `
      {
        "attributes": {
          "gen_ai.conversation.id": "<conversation_id>",
          "gen_ai.input.messages": "[{"role":"user","parts":[{"type":"text","content":"Say hello in one word."}]}]",
          "gen_ai.operation.name": "chat",
          "gen_ai.output.messages": "<output_messages>",
          "gen_ai.request.model": "gpt-5-nano",
          "gen_ai.response.id": "<response_id>",
          "gen_ai.system": "ChatOpenAI",
          "gen_ai.usage.input_tokens": "<input_tokens>",
          "gen_ai.usage.output_tokens": "<output_tokens>",
          "openinference.span.kind": "LLM",
        },
        "name": "chat gpt-5-nano",
        "span_id": Any<String>,
        "trace_id": Any<String>,
      }
    `,
    );

    await handler.shutdown();
  });

  it("maps LangGraph thread_id metadata to gen_ai.conversation.id", async () => {
    const localExporter = new TestSpanExporter();
    const { IntrospectionCallbackHandler } =
      await import("@introspection-sdk/introspection-node/langchain");

    const handler = new IntrospectionCallbackHandler({
      advanced: {
        spanExporter: localExporter,
        useSimpleSpanProcessor: true,
      },
    });

    handler.handleChainStart(
      { name: "LangGraph" },
      { input: "hello" },
      "run-1",
      undefined,
      undefined,
      { thread_id: "thread-123" },
    );
    handler.handleChainEnd({ output: "hello!" }, "run-1");
    await handler.forceFlush();

    const spans = localExporter.getFinishedSpans();
    expect(spans[0].attributes["gen_ai.conversation.id"]).toBe("thread-123");

    await handler.shutdown();
  });

  it("prefers explicit gen_ai.conversation.id over thread_id metadata", async () => {
    const localExporter = new TestSpanExporter();
    const { IntrospectionCallbackHandler } =
      await import("@introspection-sdk/introspection-node/langchain");

    const handler = new IntrospectionCallbackHandler({
      advanced: {
        spanExporter: localExporter,
        useSimpleSpanProcessor: true,
      },
    });

    handler.handleChainStart(
      { name: "LangGraph" },
      { input: "hello" },
      "run-1",
      undefined,
      undefined,
      {
        thread_id: "thread-123",
        "gen_ai.conversation.id": "conversation-456",
      },
    );
    handler.handleChainEnd({ output: "hello!" }, "run-1");
    await handler.forceFlush();

    const spans = localExporter.getFinishedSpans();
    expect(spans[0].attributes["gen_ai.conversation.id"]).toBe(
      "conversation-456",
    );

    await handler.shutdown();
  });

  it("keeps independent top-level runs in distinct traces", async () => {
    const localExporter = new TestSpanExporter();
    const { IntrospectionCallbackHandler } =
      await import("@introspection-sdk/introspection-node/langchain");

    const handler = new IntrospectionCallbackHandler({
      advanced: {
        spanExporter: localExporter,
        useSimpleSpanProcessor: true,
      },
    });

    handler.handleChainStart(
      { name: "LangGraph" },
      { input: "first" },
      "run-1",
      undefined,
      undefined,
      { thread_id: "email-1" },
    );
    handler.handleChainStart(
      { name: "LangGraph" },
      { input: "second" },
      "run-2",
      undefined,
      undefined,
      { thread_id: "email-2" },
    );
    handler.handleChainEnd({ output: "first" }, "run-1");
    handler.handleChainEnd({ output: "second" }, "run-2");
    await handler.forceFlush();

    const spans = localExporter.getFinishedSpans();
    const traceByConversation = new Map(
      spans.map((span) => [
        span.attributes["gen_ai.conversation.id"],
        span.context.trace_id,
      ]),
    );

    expect(traceByConversation.get("email-1")).not.toBe(
      traceByConversation.get("email-2"),
    );

    await handler.shutdown();
  });

  it("keeps child runs in the parent trace", async () => {
    const localExporter = new TestSpanExporter();
    const { IntrospectionCallbackHandler } =
      await import("@introspection-sdk/introspection-node/langchain");

    const handler = new IntrospectionCallbackHandler({
      advanced: {
        spanExporter: localExporter,
        useSimpleSpanProcessor: true,
      },
    });

    handler.handleChainStart(
      { name: "LangGraph" },
      { input: "hello" },
      "parent-run",
      undefined,
      undefined,
      { thread_id: "email-1" },
    );
    handler.handleToolStart(
      { name: "lookup" },
      "input",
      "child-run",
      "parent-run",
      undefined,
      { thread_id: "email-1" },
    );
    handler.handleToolEnd("output", "child-run");
    handler.handleChainEnd({ output: "done" }, "parent-run");
    await handler.forceFlush();

    const traceIds = new Set(
      localExporter.getFinishedSpans().map((span) => span.context.trace_id),
    );

    expect(traceIds.size).toBe(1);

    await handler.shutdown();
  });
});
