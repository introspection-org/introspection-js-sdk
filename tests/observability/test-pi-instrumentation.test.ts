/**
 * Tests for the Pi Agent SDK first-party instrumentation.
 *
 * Uses mock Pi agent/session objects (structural typing — no real Pi SDK needed).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
  instrumentPiModelCalls,
  instrumentPiToolExecutions,
  type PiAgentLike,
  type PiSessionLike,
  type PiInstrumentationMeta,
} from "@introspection-sdk/introspection-node/pi";

// ─────────────────────────────────────────────────────────────────────────────
// Mock Pi agent/session factories
// ─────────────────────────────────────────────────────────────────────────────

function createMockEventStream(
  events: Array<{ type: string; [key: string]: unknown }>,
) {
  const pushFn: ((event: any) => void) | null = null;
  const queue: any[] = [...events];
  let ended = false;

  return {
    push(event: any) {
      queue.push(event);
    },
    end() {
      ended = true;
    },
    async *[Symbol.asyncIterator]() {
      for (const event of queue) {
        yield event;
      }
    },
  };
}

function createMockAgent(response: {
  text?: string;
  stopReason?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  responseId?: string;
}): PiAgentLike {
  return {
    streamFn: (_model, _context, _options) => {
      return createMockEventStream([
        {
          type: "done",
          message: {
            role: "assistant",
            content: [{ type: "text", text: response.text ?? "Hello" }],
            stopReason: response.stopReason ?? "end_turn",
            usage: response.usage ?? {
              input: 100,
              output: 50,
              cacheRead: 0,
              cacheWrite: 0,
            },
            responseId: response.responseId ?? "resp-123",
          },
        },
      ]);
    },
  };
}

function createMockSession(): {
  session: PiSessionLike;
  emit: (event: Record<string, unknown>) => void;
} {
  const listeners: Array<(event: Record<string, unknown>) => void> = [];
  return {
    session: {
      subscribe(callback) {
        listeners.push(callback);
        return () => {
          const idx = listeners.indexOf(callback);
          if (idx >= 0) listeners.splice(idx, 1);
        };
      },
    },
    emit(event) {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Pi Agent SDK Instrumentation", () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  const meta: PiInstrumentationMeta = {
    conversationId: "conv-123",
    agentId: "agent-1",
    agentName: "test-agent",
  };

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
  });

  describe("instrumentPiModelCalls", () => {
    it("should create a gen_ai.call span with correct attributes", async () => {
      const agent = createMockAgent({
        text: "Hello world",
        usage: { input: 100, output: 50, cacheRead: 200, cacheWrite: 0 },
        responseId: "resp-abc",
      });
      const tracer = provider.getTracer("test");

      const unsub = instrumentPiModelCalls(agent, tracer, meta);

      // Trigger a model call
      const stream = agent.streamFn(
        { provider: "anthropic", id: "claude-sonnet-4-20250514" },
        { messages: [{ role: "user", content: "Hello" }] },
      );

      // Consume the stream
      for await (const _event of stream) {
        // just consume
      }

      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();

      expect(spans).toHaveLength(1);
      const span = spans[0]!;

      expect(span.name).toBe("gen_ai.call anthropic");
      expect(span.attributes["gen_ai.operation.name"]).toBe("chat");
      expect(span.attributes["gen_ai.conversation.id"]).toBe("conv-123");
      expect(span.attributes["gen_ai.agent.id"]).toBe("agent-1");
      expect(span.attributes["gen_ai.agent.name"]).toBe("test-agent");
      expect(span.attributes["gen_ai.provider.name"]).toBe("anthropic");
      expect(span.attributes["gen_ai.request.model"]).toBe(
        "claude-sonnet-4-20250514",
      );
      expect(span.attributes["gen_ai.usage.input_tokens"]).toBe(100);
      expect(span.attributes["gen_ai.usage.output_tokens"]).toBe(50);
      expect(span.attributes["gen_ai.usage.cache_read.input_tokens"]).toBe(200);
      expect(span.attributes["gen_ai.response.id"]).toBe("resp-abc");
      expect(span.attributes["gen_ai.input.messages"]).toBeDefined();
      expect(span.attributes["gen_ai.output.messages"]).toBeDefined();
      expect(span.status.code).toBe(SpanStatusCode.OK);

      unsub();
    });

    it("should restore original streamFn on unsubscribe", () => {
      const agent = createMockAgent({ text: "Hi" });
      const original = agent.streamFn;
      const tracer = provider.getTracer("test");

      const unsub = instrumentPiModelCalls(agent, tracer, meta);
      expect(agent.streamFn).not.toBe(original);

      unsub();
      expect(agent.streamFn).toBe(original);
    });
  });

  describe("instrumentPiToolExecutions", () => {
    it("should create spans for tool execution start/end events", async () => {
      const { session, emit } = createMockSession();
      const tracer = provider.getTracer("test");

      const unsub = instrumentPiToolExecutions(session, tracer, meta);

      emit({
        type: "tool_execution_start",
        toolCallId: "tc-1",
        toolName: "read_file",
        args: { path: "/tmp/test.txt" },
      });

      emit({
        type: "tool_execution_end",
        toolCallId: "tc-1",
        result: "file contents here",
        isError: false,
      });

      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();

      expect(spans).toHaveLength(1);
      const span = spans[0]!;

      expect(span.name).toBe("read_file");
      expect(span.attributes["gen_ai.operation.name"]).toBe("execute_tool");
      expect(span.attributes["gen_ai.tool.name"]).toBe("read_file");
      expect(span.attributes["gen_ai.tool.call.id"]).toBe("tc-1");
      expect(span.attributes["gen_ai.tool.call.arguments"]).toBe(
        '{"path":"/tmp/test.txt"}',
      );
      expect(span.attributes["gen_ai.tool.call.result"]).toBe(
        "file contents here",
      );
      expect(span.attributes["gen_ai.conversation.id"]).toBe("conv-123");
      expect(span.status.code).toBe(SpanStatusCode.OK);

      unsub();
    });

    it("should set error status on failed tool execution", async () => {
      const { session, emit } = createMockSession();
      const tracer = provider.getTracer("test");

      const unsub = instrumentPiToolExecutions(session, tracer, meta);

      emit({
        type: "tool_execution_start",
        toolCallId: "tc-2",
        toolName: "exec",
        args: { command: "bad-cmd" },
      });

      emit({
        type: "tool_execution_end",
        toolCallId: "tc-2",
        result: "command not found",
        isError: true,
      });

      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();

      expect(spans).toHaveLength(1);
      expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);

      unsub();
    });

    it("should end active spans on unsubscribe", async () => {
      const { session, emit } = createMockSession();
      const tracer = provider.getTracer("test");

      const unsub = instrumentPiToolExecutions(session, tracer, meta);

      // Start a tool but don't end it
      emit({
        type: "tool_execution_start",
        toolCallId: "tc-3",
        toolName: "long_running_tool",
      });

      unsub(); // Should end the orphaned span

      await provider.forceFlush();
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      expect(spans[0]!.name).toBe("long_running_tool");
    });
  });
});
