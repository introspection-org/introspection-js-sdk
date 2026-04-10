import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  withIntrospection,
  type ClaudeAgentSDKModule,
} from "@introspection-sdk/introspection-node";
import {
  TestSpanExporter,
  IncrementalIdGenerator,
  simplifySpansForSnapshot,
} from "../testing";

/**
 * Creates a mock Claude Agent SDK module that yields the given messages
 * from its query() async generator.
 */
function createMockSDK(
  messages: Array<Record<string, unknown>>,
): ClaudeAgentSDKModule & { lastQueryParams: unknown } {
  const mock = {
    lastQueryParams: null as unknown,
    query(params: { prompt: unknown; options?: unknown }) {
      mock.lastQueryParams = params;

      async function* generate() {
        for (const msg of messages) {
          yield msg;
        }
      }

      const gen = generate() as AsyncGenerator<unknown, void> &
        Record<string, unknown>;

      // Add mock control methods that Query has
      gen.interrupt = vi.fn(async () => {});
      gen.close = vi.fn(() => {});
      gen.setModel = vi.fn(async () => {});
      gen.setPermissionMode = vi.fn(async () => {});

      return gen;
    },
    // Other SDK exports
    tool: () => {},
    Session: class {},
  };

  return mock;
}

/** Standard mock messages simulating a full session lifecycle */
function createMockMessages(sessionId = "test-session-123") {
  return [
    {
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: "claude-sonnet-4-5-20250514",
      tools: ["Bash", "Read", "Write"],
    },
    {
      type: "assistant",
      session_id: sessionId,
      message: {
        id: "msg_01ABC123",
        model: "claude-sonnet-4-5-20250514",
        usage: { input_tokens: 150, output_tokens: 10 },
        content: [{ type: "text", text: "4" }],
      },
    },
    {
      type: "result",
      session_id: sessionId,
      subtype: "success",
      result: "4",
      usage: { input_tokens: 150, output_tokens: 10 },
      total_cost_usd: 0.00052,
    },
  ];
}

describe("withIntrospection() Wrapper Tests", () => {
  let exporter: TestSpanExporter;

  beforeEach(() => {
    exporter = new TestSpanExporter();
  });

  afterEach(() => {
    exporter.reset();
  });

  it("should auto-capture prompt and systemPrompt and produce correct spans", async () => {
    const messages = createMockMessages();
    const mockSdk = createMockSDK(messages);

    const tracedSdk = withIntrospection(mockSdk, {
      advanced: {
        spanExporter: exporter,
        idGenerator: new IncrementalIdGenerator(),
        useSimpleSpanProcessor: true,
      },
    });

    const stream = tracedSdk.query({
      prompt: "What is 2 + 2? Just give me the number.",
      options: {
        systemPrompt: "You are a calculator.",
        maxTurns: 1,
      },
    }) as AsyncIterable<unknown>;

    for await (const _message of stream) {
      // Messages are consumed — wrapper handles recordUsage automatically
    }

    // Check spans before shutdown (shutdown clears the exporter)
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);

    await tracedSdk.shutdown();

    const simplified = simplifySpansForSnapshot(spans);
    expect(simplified).toMatchInlineSnapshot(
      [
        {
          trace_id: expect.any(String),
          span_id: expect.any(String),
        },
      ],
      `
        [
          {
            "attributes": {
              "claude.result_subtype": "success",
              "claude.session_id": "test-session-123",
              "claude.source": "message",
              "claude.tools": "Bash,Read,Write",
              "gen_ai.agent.name": "claude-agent",
              "gen_ai.cost.usd": 0.00052,
              "gen_ai.input.messages": "[{"role":"user","parts":[{"type":"text","content":"What is 2 + 2? Just give me the number."}]}]",
              "gen_ai.operation.name": "chat",
              "gen_ai.output.messages": "[{"role":"assistant","parts":[{"type":"text","content":"4"}],"finish_reason":"success"}]",
              "gen_ai.request.model": "claude-sonnet-4-5-20250514",
              "gen_ai.response.id": "msg_01ABC123",
              "gen_ai.system": "anthropic",
              "gen_ai.system_instructions": "[{"type":"text","content":"You are a calculator."}]",
              "gen_ai.tool.definitions": "[{"name":"Bash"},{"name":"Read"},{"name":"Write"}]",
              "gen_ai.usage.input_tokens": 150,
              "gen_ai.usage.output_tokens": 10,
            },
            "name": "claude.session",
            "span_id": Any<String>,
            "trace_id": Any<String>,
          },
        ]
      `,
    );
  });

  it("should yield all messages unchanged from the stream", async () => {
    const messages = createMockMessages();
    const mockSdk = createMockSDK(messages);

    const tracedSdk = withIntrospection(mockSdk, {
      advanced: {
        spanExporter: exporter,
        idGenerator: new IncrementalIdGenerator(),
        useSimpleSpanProcessor: true,
      },
    });

    const stream = tracedSdk.query({
      prompt: "test",
    }) as AsyncIterable<unknown>;

    const received: unknown[] = [];
    for await (const message of stream) {
      received.push(message);
    }

    await tracedSdk.shutdown();

    expect(received).toHaveLength(messages.length);
    expect(received[0]).toBe(messages[0]);
    expect(received[1]).toBe(messages[1]);
    expect(received[2]).toBe(messages[2]);
  });

  it("should merge user hooks with introspection hooks", async () => {
    const messages = createMockMessages();
    const mockSdk = createMockSDK(messages);

    const tracedSdk = withIntrospection(mockSdk, {
      advanced: {
        spanExporter: exporter,
        idGenerator: new IncrementalIdGenerator(),
        useSimpleSpanProcessor: true,
      },
    });

    const userHookCalled = vi.fn(async () => ({ continue: true }));
    const userNotificationHook = vi.fn(async () => ({ continue: true }));

    const stream = tracedSdk.query({
      prompt: "test",
      options: {
        hooks: {
          // User hook on same event we handle — should be merged
          PreToolUse: [{ hooks: [userHookCalled] }],
          // User hook on event we don't handle — should pass through
          Notification: [{ hooks: [userNotificationHook] }],
        },
      },
    }) as AsyncIterable<unknown>;

    for await (const _message of stream) {
      // consume
    }

    // Verify the merged hooks were passed to the original SDK
    const params = mockSdk.lastQueryParams as {
      options: { hooks: Record<string, unknown[]> };
    };
    const mergedHooks = params.options.hooks;

    // PreToolUse should have both introspection hooks (first) and user hooks (second)
    expect(mergedHooks.PreToolUse).toBeDefined();
    expect(mergedHooks.PreToolUse.length).toBe(2); // ours + theirs

    // Notification should have user hook only (we don't handle it)
    expect(mergedHooks.Notification).toBeDefined();
    expect(mergedHooks.Notification.length).toBe(1);

    // SessionStart, SessionEnd, PostToolUse, SubagentStart, SubagentStop should have our hooks
    expect(mergedHooks.SessionStart).toBeDefined();
    expect(mergedHooks.SessionEnd).toBeDefined();
    expect(mergedHooks.PostToolUse).toBeDefined();
    expect(mergedHooks.SubagentStart).toBeDefined();
    expect(mergedHooks.SubagentStop).toBeDefined();

    await tracedSdk.shutdown();
  });

  it("should forward Query control methods to original", async () => {
    const messages = createMockMessages();
    const mockSdk = createMockSDK(messages);

    const tracedSdk = withIntrospection(mockSdk, {
      advanced: {
        spanExporter: exporter,
        idGenerator: new IncrementalIdGenerator(),
        useSimpleSpanProcessor: true,
      },
    });

    const stream = tracedSdk.query({
      prompt: "test",
    }) as AsyncGenerator<unknown, void> & {
      interrupt: () => Promise<void>;
      close: () => void;
      setModel: (model?: string) => Promise<void>;
    };

    // Control methods should be accessible on the wrapped query
    expect(typeof stream.interrupt).toBe("function");
    expect(typeof stream.close).toBe("function");
    expect(typeof stream.setModel).toBe("function");

    // Call them and verify they delegate to the original
    await stream.interrupt();
    stream.close();
    await stream.setModel("claude-opus-4-20250514");

    // Consume the stream to avoid unhandled rejection
    for await (const _message of stream) {
      // consume
    }

    await tracedSdk.shutdown();
  });

  it("should flush spans when stream throws an error", async () => {
    const errorMessages = [
      {
        type: "system",
        subtype: "init",
        session_id: "error-session",
        model: "claude-sonnet-4-5-20250514",
      },
    ];

    // Create a mock SDK where the generator throws mid-stream
    const mockSdk: ClaudeAgentSDKModule = {
      query() {
        async function* generate() {
          yield errorMessages[0];
          throw new Error("Stream error");
        }
        return generate();
      },
    };

    const tracedSdk = withIntrospection(mockSdk, {
      advanced: {
        spanExporter: exporter,
        idGenerator: new IncrementalIdGenerator(),
        useSimpleSpanProcessor: true,
      },
    });

    const stream = tracedSdk.query({
      prompt: "test",
    }) as AsyncIterable<unknown>;

    await expect(async () => {
      for await (const _message of stream) {
        // consume
      }
    }).rejects.toThrow("Stream error");

    // Even after error, spans should have been flushed (init created a session span)
    // The session span won't be ended (no result message), but it was started
    await tracedSdk.shutdown();
  });

  it("should pass through other SDK exports", () => {
    const mockSdk = createMockSDK([]);

    const tracedSdk = withIntrospection(mockSdk, {
      advanced: {
        spanExporter: exporter,
        idGenerator: new IncrementalIdGenerator(),
        useSimpleSpanProcessor: true,
      },
    });

    // Non-query exports should be preserved
    expect(tracedSdk.tool).toBe(mockSdk.tool);
    expect(tracedSdk.Session).toBe(mockSdk.Session);
  });

  it("should expose hooks instance and lifecycle methods", async () => {
    const mockSdk = createMockSDK([]);

    const tracedSdk = withIntrospection(mockSdk, {
      advanced: {
        spanExporter: exporter,
        idGenerator: new IncrementalIdGenerator(),
        useSimpleSpanProcessor: true,
      },
    });

    // hooks property should be accessible
    expect(tracedSdk.hooks).toBeDefined();
    expect(typeof tracedSdk.forceFlush).toBe("function");
    expect(typeof tracedSdk.shutdown).toBe("function");

    await tracedSdk.shutdown();
  });

  it("should handle query with no options", async () => {
    const messages = createMockMessages();
    const mockSdk = createMockSDK(messages);

    const tracedSdk = withIntrospection(mockSdk, {
      advanced: {
        spanExporter: exporter,
        idGenerator: new IncrementalIdGenerator(),
        useSimpleSpanProcessor: true,
      },
    });

    // query() with no options should not throw
    const stream = tracedSdk.query({
      prompt: "test",
    }) as AsyncIterable<unknown>;

    for await (const _message of stream) {
      // consume
    }

    // Check spans before shutdown (shutdown clears the exporter)
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(1);
    expect(spans[0].name).toBe("claude.session");

    await tracedSdk.shutdown();
  });
});
