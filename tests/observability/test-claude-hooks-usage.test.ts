/**
 * Coverage for IntrospectionClaudeHooks usage/session bookkeeping, driven
 * directly through recordUsage() + setInputPrompt/setSystemInstructions with
 * constructed Claude Agent SDK messages. No mocks: a real InMemorySpanExporter
 * captures the session span the hooks emit. (Full agent runs are covered by the
 * Polly-backed test-claude*.test.ts files.)
 */
import { describe, expect, it } from "vitest";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";

import {
  IntrospectionClaudeHooks,
  type ClaudeSDKMessage,
} from "../../packages/introspection-node/src/otel/claude-hooks";

function makeHooks() {
  const exporter = new InMemorySpanExporter();
  const hooks = new IntrospectionClaudeHooks({
    serviceName: "claude-test",
    agentName: "Tester",
    agentId: "agent-1",
    conversationId: "conv-1",
    advanced: { spanExporter: exporter, useSimpleSpanProcessor: true },
  });
  return { hooks, exporter };
}

const initMsg = (sessionId: string): ClaudeSDKMessage =>
  ({
    type: "system",
    subtype: "init",
    session_id: sessionId,
    model: "claude-sonnet-4-6",
    tools: ["Read", "Bash"],
  }) as unknown as ClaudeSDKMessage;

const assistantMsg = (sessionId: string): ClaudeSDKMessage =>
  ({
    type: "assistant",
    session_id: sessionId,
    message: {
      id: "msg_1",
      model: "claude-sonnet-4-6",
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
      content: [{ type: "text", text: "the answer is 4" }],
    },
  }) as unknown as ClaudeSDKMessage;

const resultMsg = (sessionId: string, subtype = "success"): ClaudeSDKMessage =>
  ({
    type: "result",
    subtype,
    session_id: sessionId,
    usage: { input_tokens: 120, output_tokens: 45 },
    modelUsage: {
      "claude-sonnet-4-6": {
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 2,
      },
    },
    total_cost_usd: 0.0123,
  }) as unknown as ClaudeSDKMessage;

describe("IntrospectionClaudeHooks.recordUsage", () => {
  it("starts, accumulates, and ends a session span over a full message stream", async () => {
    const { hooks, exporter } = makeHooks();

    // Buffered before the session id is known.
    hooks.setInputPrompt("What is 2+2?");
    hooks.setSystemInstructions("Be terse.");

    hooks.recordUsage(initMsg("s1"));
    hooks.recordUsage(assistantMsg("s1"));
    hooks.recordUsage(resultMsg("s1"));

    // SimpleSpanProcessor exports on span end — assert before shutdown(), which
    // clears the in-memory exporter.
    const spans = exporter.getFinishedSpans();
    const session = spans.find((s) => s.name === "claude.session");
    expect(session).toBeDefined();
    expect(session!.attributes["gen_ai.agent.name"]).toBe("Tester");
    expect(session!.attributes["gen_ai.conversation.id"]).toBe("conv-1");
    expect(session!.attributes["gen_ai.request.model"]).toBe(
      "claude-sonnet-4-6",
    );
    expect(session!.attributes["claude.result_subtype"]).toBe("success");

    await hooks.shutdown();
  });

  it("buffers per-session prompt/instructions and ignores duplicate init", async () => {
    const { hooks, exporter } = makeHooks();
    hooks.recordUsage(initMsg("s2"));
    // Explicit-sessionId branch of the setters (session already started).
    hooks.setInputPrompt("late prompt", "s2");
    hooks.setSystemInstructions("late system", "s2");
    // Duplicate init is skipped (session span already exists).
    hooks.recordUsage(initMsg("s2"));
    hooks.recordUsage(resultMsg("s2", "error_max_turns"));

    const session = exporter
      .getFinishedSpans()
      .find((s) => s.name === "claude.session");
    expect(session).toBeDefined();
    // Non-success subtype maps to an ERROR status.
    expect(session!.attributes["claude.result_subtype"]).toBe(
      "error_max_turns",
    );

    await hooks.shutdown();
  });

  it("no-ops a result for a session that never started", async () => {
    const { hooks, exporter } = makeHooks();
    expect(() => hooks.recordUsage(resultMsg("ghost"))).not.toThrow();
    expect(
      exporter.getFinishedSpans().find((s) => s.name === "claude.session"),
    ).toBeUndefined();
    await hooks.shutdown();
  });

  it("exposes a complete hooks config", () => {
    const { hooks } = makeHooks();
    const cfg = hooks.getHooks();
    expect(Object.keys(cfg)).toEqual(
      expect.arrayContaining([
        "SessionStart",
        "SessionEnd",
        "PreToolUse",
        "PostToolUse",
        "SubagentStart",
        "SubagentStop",
      ]),
    );
  });

  it("drives the session + tool hook callbacks end-to-end", async () => {
    const { hooks, exporter } = makeHooks();
    const cfg = hooks.getHooks();
    const base = { transcript_path: "/t", cwd: "/w" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const call = (matchers: any, input: any) => matchers![0].hooks[0](input);

    await call(cfg.SessionStart, {
      hook_event_name: "SessionStart",
      session_id: "h1",
      source: "startup",
      model: "claude-sonnet-4-6",
      agent_type: "main",
      ...base,
    });
    await call(cfg.PreToolUse, {
      hook_event_name: "PreToolUse",
      session_id: "h1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_use_id: "tu1",
      ...base,
    });
    await call(cfg.PostToolUse, {
      hook_event_name: "PostToolUse",
      session_id: "h1",
      tool_name: "Bash",
      tool_input: { command: "ls" },
      tool_response: { output: "file.txt" },
      tool_use_id: "tu1",
      ...base,
    });
    await call(cfg.SessionEnd, {
      hook_event_name: "SessionEnd",
      session_id: "h1",
      reason: "done",
      ...base,
    });

    const names = exporter.getFinishedSpans().map((s) => s.name);
    expect(names).toContain("tool.Bash");
    expect(names).toContain("claude.session");

    await hooks.shutdown();
  });
});
