import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Polly } from "@pollyjs/core";
import { IntrospectionClaudeHooks } from "@introspection-sdk/introspection-node";
import {
  TestSpanExporter,
  IncrementalIdGenerator,
  simplifySpansForSnapshot,
  sortSpansBySpanId,
} from "../testing";
import { setupPolly, ensureEnvVarsForReplay } from "../polly-setup";

describe("Claude Agent SDK Tests", () => {
  let hooks: IntrospectionClaudeHooks | null = null;
  let exporter: TestSpanExporter | null = null;
  let polly: Polly | null = null;

  beforeEach(async () => {
    polly = setupPolly({
      recordingName: "claude-agent-sdk",
      adapters: ["fetch"],
    });
    ensureEnvVarsForReplay(["ANTHROPIC_API_KEY"], "claude-agent-sdk");

    exporter = new TestSpanExporter();
    hooks = new IntrospectionClaudeHooks({
      advanced: {
        spanExporter: exporter,
        idGenerator: new IncrementalIdGenerator(),
        useSimpleSpanProcessor: true,
      },
    });
  });

  afterEach(async () => {
    if (hooks) {
      await hooks.shutdown();
      hooks = null;
    }
    exporter = null;
    if (polly) {
      await polly.stop();
      polly = null;
    }
  });

  it("should capture session with all gen_ai attributes from message flow", async () => {
    if (!hooks || !exporter) return;

    const sessionId = "test-session-123";
    const prompt = "What is 2 + 2? Just give me the number.";
    const systemPrompt = "You are a calculator.";

    hooks.setInputPrompt(prompt);
    hooks.setSystemInstructions(systemPrompt);

    // Simulate init message (system/init)
    hooks.recordUsage({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: "claude-sonnet-4-5-20250514",
      tools: ["Bash", "Read", "Write"],
    } as any);

    // Simulate assistant message with content, usage, and response ID
    hooks.recordUsage({
      type: "assistant",
      session_id: sessionId,
      message: {
        id: "msg_01ABC123",
        model: "claude-sonnet-4-5-20250514",
        usage: {
          input_tokens: 150,
          output_tokens: 10,
        },
        content: [{ type: "text", text: "4" }],
      },
    } as any);

    // Simulate result message (ends the session span)
    hooks.recordUsage({
      type: "result",
      session_id: sessionId,
      subtype: "success",
      result: "4",
      usage: {
        input_tokens: 150,
        output_tokens: 10,
      },
      total_cost_usd: 0.00052,
    } as any);

    await hooks.forceFlush();
    const spans = exporter.getFinishedSpans();

    expect(spans.length).toBe(1);

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

  it("should capture tool use spans with gen_ai attributes", async () => {
    if (!hooks || !exporter) return;

    const sessionId = "test-session-456";

    hooks.setInputPrompt("List files in the current directory");

    // Init
    hooks.recordUsage({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      model: "claude-sonnet-4-5-20250514",
    } as any);

    // Simulate PreToolUse hook
    const hookInput = {
      hook_event_name: "PreToolUse" as const,
      session_id: sessionId,
      transcript_path: "/tmp/transcript",
      cwd: "/home/user",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      tool_use_id: "tool-use-1",
    };
    const hooksConfig = hooks.getHooks();
    await hooksConfig.PreToolUse![0].hooks[0](hookInput, "tool-use-1", {
      signal: new AbortController().signal,
    });

    // Simulate PostToolUse hook
    const postInput = {
      hook_event_name: "PostToolUse" as const,
      session_id: sessionId,
      transcript_path: "/tmp/transcript",
      cwd: "/home/user",
      tool_name: "Bash",
      tool_input: { command: "ls -la" },
      tool_response: "file1.txt\nfile2.txt\n",
      tool_use_id: "tool-use-1",
    };
    await hooksConfig.PostToolUse![0].hooks[0](postInput, "tool-use-1", {
      signal: new AbortController().signal,
    });

    // Assistant response
    hooks.recordUsage({
      type: "assistant",
      session_id: sessionId,
      message: {
        id: "msg_02DEF456",
        model: "claude-sonnet-4-5-20250514",
        usage: { input_tokens: 200, output_tokens: 50 },
        content: [
          {
            type: "text",
            text: "The directory contains file1.txt and file2.txt.",
          },
        ],
      },
    } as any);

    // Result
    hooks.recordUsage({
      type: "result",
      session_id: sessionId,
      subtype: "success",
      usage: { input_tokens: 200, output_tokens: 50 },
      total_cost_usd: 0.001,
    } as any);

    await hooks.forceFlush();
    const spans = exporter.getFinishedSpans();
    expect(spans.length).toBe(2);

    const sorted = sortSpansBySpanId(spans);
    const simplified = simplifySpansForSnapshot(sorted);
    expect(simplified).toMatchInlineSnapshot(
      [
        {
          trace_id: expect.any(String),
          span_id: expect.any(String),
        },
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
              "claude.session_id": "test-session-456",
              "claude.source": "message",
              "gen_ai.agent.name": "claude-agent",
              "gen_ai.cost.usd": 0.001,
              "gen_ai.input.messages": "[{"role":"user","parts":[{"type":"text","content":"List files in the current directory"}]}]",
              "gen_ai.operation.name": "chat",
              "gen_ai.output.messages": "[{"role":"assistant","parts":[{"type":"text","content":"The directory contains file1.txt and file2.txt."}],"finish_reason":"success"}]",
              "gen_ai.request.model": "claude-sonnet-4-5-20250514",
              "gen_ai.response.id": "msg_02DEF456",
              "gen_ai.system": "anthropic",
              "gen_ai.usage.input_tokens": 200,
              "gen_ai.usage.output_tokens": 50,
            },
            "name": "claude.session",
            "span_id": Any<String>,
            "trace_id": Any<String>,
          },
          {
            "attributes": {
              "claude.session_id": "test-session-456",
              "claude.tool_use_id": "tool-use-1",
              "gen_ai.tool.input": "{"command":"ls -la"}",
              "gen_ai.tool.name": "Bash",
              "gen_ai.tool.output": ""file1.txt\\nfile2.txt\\n"",
            },
            "name": "tool.Bash",
            "span_id": Any<String>,
            "trace_id": Any<String>,
          },
        ]
      `,
    );
  });

  it("should capture live Claude Agent SDK session with gen_ai attributes", async () => {
    if (!hooks || !exporter) return;

    if (!process.env.ANTHROPIC_API_KEY) {
      console.log("Skipping: ANTHROPIC_API_KEY not set");
      return;
    }

    let queryFn: typeof import("@anthropic-ai/claude-agent-sdk").query;
    try {
      const mod = await import("@anthropic-ai/claude-agent-sdk");
      queryFn = mod.query;
    } catch {
      console.log("Skipping: @anthropic-ai/claude-agent-sdk not installed");
      return;
    }

    const prompt = "What is 2 + 2? Just give me the number.";
    hooks.setInputPrompt(prompt);

    const stream = queryFn({
      prompt,
      options: {
        maxTurns: 1,
      },
    });

    for await (const message of stream) {
      hooks.recordUsage(message as any);
    }

    await hooks.forceFlush();
    const spans = exporter.getFinishedSpans();

    expect(spans.length).toBeGreaterThan(0);

    const sessionSpan = spans.find((s) => s.name === "claude.session");
    expect(sessionSpan).toBeDefined();

    const attrs = sessionSpan!.attributes;
    expect(attrs["gen_ai.system"]).toBe("anthropic");
    expect(attrs["gen_ai.request.model"]).toEqual(expect.any(String));
    expect(attrs["gen_ai.usage.input_tokens"]).toEqual(expect.any(Number));
    expect(attrs["gen_ai.usage.output_tokens"]).toEqual(expect.any(Number));
    expect(attrs["gen_ai.input.messages"]).toEqual(expect.any(String));
    expect(attrs["gen_ai.output.messages"]).toEqual(expect.any(String));
    expect(attrs["gen_ai.response.id"]).toEqual(expect.any(String));
  });
});
