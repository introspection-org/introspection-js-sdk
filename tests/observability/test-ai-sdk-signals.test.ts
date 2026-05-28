/**
 * Signal-input capture tests — Vercel AI SDK (native telemetry).
 *
 * Signals (`signals.interaction.*`, `signals.execution.*`,
 * `signals.environment.*`) are computed server-side by the brightstaff
 * crate, which scans `gen_ai.input.messages` / `gen_ai.output.messages`
 * for the user phrases and tool error patterns it knows. These tests
 * verify the *client-side inputs* the detector relies on are captured
 * correctly onto spans for every signal category exercised by
 * `examples/otel/vercel/signals.ts`:
 *
 *   - User trigger phrases appear in `gen_ai.input.messages` (interaction
 *     signals: disengagement / satisfaction / stagnation / misalignment).
 *   - Tool error strings emitted from `execute()` appear as
 *     `tool_call_response` parts in the next step's
 *     `gen_ai.input.messages` (execution.failure.* and
 *     environment.exhaustion.*).
 *   - Repeated tool calls produce one step span per call, so loop signals
 *     (execution.loops.{retry, parameter_drift}) can count them.
 *
 * We use `MockLanguageModelV3` from `ai/test` rather than Polly recordings:
 * the inputs being verified are independent of the model's output, the full
 * signals example would otherwise require 20+ HAR files (`dragging` alone is
 * 10 round-trips), and the mock keeps the suite deterministic and runnable
 * without an Anthropic key. The companion example
 * (`examples/otel/vercel/signals.ts`) is the live-API counterpart for end-to-end
 * signal emission against the Introspection backend.
 *
 * Uses the native AI SDK telemetry pathway introduced by PR #54:
 * `IntrospectionSpanProcessor` registered on the global tracer runs
 * `convertVercelAIToGenAI` at onEnd, so `ai.prompt.messages` →
 * `gen_ai.input.messages` for any span the SDK produces with
 * `experimental_telemetry: { isEnabled: true }`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { generateText, stepCountIs, tool } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { z } from "zod";
import { IntrospectionSpanProcessor } from "@introspection-sdk/introspection-node/otel";
import {
  TestSpanExporter,
  IncrementalIdGenerator,
  parseJsonAttr,
} from "../testing";
import { installTestOTelGlobals } from "../polly-setup";

interface MessagePart {
  type: string;
  content?: string;
  response?: string;
  name?: string;
  arguments?: string;
}
interface InputMessage {
  role: string;
  parts: MessagePart[];
}

/** Collect all text from user-role parts across every input message. */
function userTexts(messages: InputMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const p of m.parts) {
      if (p.type === "text" && p.content) out.push(p.content);
    }
  }
  return out;
}

/** Collect every tool_call_response payload across the input history. */
function toolResponses(messages: InputMessage[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === "tool_call_response" && p.response) out.push(p.response);
    }
  }
  return out;
}

/** Step spans only (skip the root span that groups the generation). */
function stepSpans(exporter: TestSpanExporter) {
  return exporter
    .getFinishedSpans()
    .filter((s) => s.attributes["gen_ai.operation.name"] === "chat");
}

// The mocked doGenerate result must satisfy LanguageModelV3GenerateResult,
// but importing that type from @ai-sdk/provider would add a dep we don't
// otherwise need. `any` is acceptable here — the runtime contract is
// exercised by the AI SDK directly.
type GenResult = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** Build a mock that always returns the same plain-text response. */
function textOnlyModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async (): Promise<GenResult> => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: USAGE,
      response: { id: "resp-mock", modelId: "mock-model" },
    }),
  });
}

/**
 * Build a mock that issues one tool call on the first generate, then a final
 * text answer once it sees a tool result in the prompt.
 */
function singleToolCallThenAnswer(
  toolName: string,
  args: Record<string, unknown>,
  finalText = "done",
): MockLanguageModelV3 {
  let calls = 0;
  return new MockLanguageModelV3({
    doGenerate: async (): Promise<GenResult> => {
      calls++;
      if (calls === 1) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: `call-${calls}`,
              toolName,
              input: JSON.stringify(args),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage: USAGE,
          response: { id: `resp-${calls}`, modelId: "mock-model" },
        };
      }
      return {
        content: [{ type: "text", text: finalText }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: USAGE,
        response: { id: `resp-${calls}`, modelId: "mock-model" },
      };
    },
  });
}

/**
 * Build a mock that repeatedly issues the same tool call (same args) up to
 * `maxCalls` times, then gives up with a plain-text response. Drives
 * execution.loops.retry.
 */
function repeatingToolCall(
  toolName: string,
  args: Record<string, unknown>,
  maxCalls: number,
): MockLanguageModelV3 {
  let calls = 0;
  return new MockLanguageModelV3({
    doGenerate: async (): Promise<GenResult> => {
      calls++;
      if (calls <= maxCalls) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: `call-${calls}`,
              toolName,
              input: JSON.stringify(args),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage: USAGE,
          response: { id: `resp-${calls}`, modelId: "mock-model" },
        };
      }
      return {
        content: [{ type: "text", text: "giving up" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: USAGE,
        response: { id: `resp-${calls}`, modelId: "mock-model" },
      };
    },
  });
}

/**
 * Build a mock that issues the same tool call with progressively different
 * argument values. Drives execution.loops.parameter_drift.
 */
function driftingToolCall(
  toolName: string,
  argKey: string,
  values: string[],
): MockLanguageModelV3 {
  let calls = 0;
  return new MockLanguageModelV3({
    doGenerate: async (): Promise<GenResult> => {
      calls++;
      if (calls <= values.length) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: `call-${calls}`,
              toolName,
              input: JSON.stringify({ [argKey]: values[calls - 1] }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool_use" },
          usage: USAGE,
          response: { id: `resp-${calls}`, modelId: "mock-model" },
        };
      }
      return {
        content: [{ type: "text", text: "no luck" }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: USAGE,
        response: { id: `resp-${calls}`, modelId: "mock-model" },
      };
    },
  });
}

// ---------------------------------------------------------------------------

describe("AI SDK signal-input capture", () => {
  let exporter: TestSpanExporter;
  let provider: NodeTracerProvider;
  let disposeOTel: () => void;

  beforeEach(() => {
    // Reset OTel globals so each test gets a clean tracer registration.
    disposeOTel = installTestOTelGlobals();

    exporter = new TestSpanExporter();
    // Register IntrospectionSpanProcessor on the global tracer the AI SDK
    // uses when `experimental_telemetry: { isEnabled: true }` is set. The
    // processor's onEnd runs convertVercelAIToGenAI for every ai.* span.
    // We rely on the explicit `provider.forceFlush()` calls in each test to
    // drain BatchSpanProcessor's buffer.
    provider = new NodeTracerProvider({
      idGenerator: new IncrementalIdGenerator(),
      spanProcessors: [
        new IntrospectionSpanProcessor({
          token: "test-token",
          advanced: { spanExporter: exporter },
        }),
      ],
    });
    provider.register();
  });

  afterEach(async () => {
    await provider.forceFlush();
    await provider.shutdown();
    disposeOTel();
  });

  const enableTelemetry = (functionId: string) => ({
    isEnabled: true,
    functionId,
  });

  // ── Interaction signals ──────────────────────────────────────────────────

  // Each row: [signal leaf, the user phrase fed in as the most recent turn].
  // The brightstaff interaction detectors use n-gram / cosine similarity
  // against ~50–90 phrase lists per leaf; the SDK's contract is just to land
  // the user text in `gen_ai.input.messages`.
  const interactionCases: Array<[string, string]> = [
    [
      "interaction.disengagement.negative_stance",
      "This is useless, you're not helping me at all.",
    ],
    ["interaction.disengagement.escalation", "Get me a human agent please."],
    [
      "interaction.disengagement.quit",
      "Forget it, I give up. This is going nowhere.",
    ],
    [
      "interaction.satisfaction.gratitude",
      "That's perfect, appreciate it! Really helpful.",
    ],
    [
      "interaction.satisfaction.confirmation",
      "That works perfectly, love it! Solves my issue.",
    ],
    [
      "interaction.satisfaction.success",
      "It worked! That fix did the job, thanks.",
    ],
    // Misalignment leaves per brightstaff: correction, rephrase, clarification.
    [
      "interaction.misalignment.correction",
      "No, I meant Portland, Maine — not Portland, Oregon. Please redo it.",
    ],
    [
      "interaction.misalignment.clarification",
      "I don't understand what you mean. Can you clarify that?",
    ],
  ];

  for (const [leaf, phrase] of interactionCases) {
    it(`captures user trigger for ${leaf}`, async () => {
      await generateText({
        model: textOnlyModel("ok"),
        messages: [
          { role: "user", content: "initial question" },
          { role: "assistant", content: "initial answer" },
          { role: "user", content: phrase },
        ],
        experimental_telemetry: enableTelemetry(leaf),
      });

      await provider.forceFlush();
      const [step] = stepSpans(exporter);
      expect(step, "expected exactly one step span").toBeDefined();

      const input = parseJsonAttr(
        step.attributes["gen_ai.input.messages"],
      ) as InputMessage[];
      expect(userTexts(input)).toContain(phrase);
    });
  }

  it("captures growing input history for stagnation.dragging", async () => {
    // brightstaff's dragging detector fires at ≥8 user turns. We send 6 here
    // (mock model is fast) and just assert every turn lands in the last
    // span's input — the SDK's contract is the message history, the
    // threshold is the server's.
    const questions = [
      "What is a variable?",
      "What is a function?",
      "What is a loop?",
      "What is recursion?",
      "What is an array?",
      "What is a class?",
    ];

    const history: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (const q of questions) {
      history.push({ role: "user", content: q });
      await generateText({
        model: textOnlyModel(`answer: ${q}`),
        messages: history,
        experimental_telemetry: enableTelemetry("stagnation.dragging"),
      });
      history.push({ role: "assistant", content: `answer: ${q}` });
    }

    await provider.forceFlush();
    const spans = stepSpans(exporter);
    expect(spans.length).toBe(questions.length);

    const lastInput = parseJsonAttr(
      spans[spans.length - 1].attributes["gen_ai.input.messages"],
    ) as InputMessage[];
    const texts = userTexts(lastInput);
    for (const q of questions) {
      expect(texts).toContain(q);
    }
  });

  // ── Execution failures ───────────────────────────────────────────────────

  // The detector matches case-insensitive regex against the tool's error
  // string in the observation. We assert that string lands in the next
  // step's input messages as a tool_call_response.
  const failureCases: Array<[string, string]> = [
    [
      "execution.failure.invalid_args",
      "Error: validation failed — expected integer got string for field 'age'",
    ],
    [
      "execution.failure.tool_not_found",
      "Error: unknown function 'sendReport' — no such tool is registered",
    ],
    [
      "execution.failure.auth_misuse",
      "HTTP 401 Unauthorized — invalid credentials, please check your API token",
    ],
    [
      "execution.failure.state_error",
      "Error: invalid state — must call begin_session first before committing a transaction",
    ],
    [
      "execution.failure.bad_query",
      "Error: invalid query syntax error near 'WHERE' — unknown field in filter expression",
    ],
  ];

  for (const [leaf, errorText] of failureCases) {
    it(`captures tool error for ${leaf}`, async () => {
      const toolName = "fakeTool";
      const myTool = tool({
        description: "A tool whose execute() returns a canned error string.",
        inputSchema: z.object({ value: z.string() }),
        execute: async () => errorText,
      });

      await generateText({
        model: singleToolCallThenAnswer(toolName, { value: "x" }),
        tools: { [toolName]: myTool },
        stopWhen: stepCountIs(3),
        messages: [{ role: "user", content: "trigger the tool" }],
        experimental_telemetry: enableTelemetry(leaf),
      });

      await provider.forceFlush();
      const spans = stepSpans(exporter);
      expect(spans.length).toBe(2);

      const secondInput = parseJsonAttr(
        spans[1].attributes["gen_ai.input.messages"],
      ) as InputMessage[];
      const responses = toolResponses(secondInput);
      expect(responses.some((r) => r.includes(errorText))).toBe(true);
    });
  }

  // ── Environment exhaustion ───────────────────────────────────────────────

  const exhaustionCases: Array<[string, string]> = [
    [
      "environment.exhaustion.api_error",
      "503 service unavailable — the server is temporarily down, try again later",
    ],
    [
      "environment.exhaustion.timeout",
      "Connection timed out after 30 seconds — request exceeded the maximum wait time",
    ],
    [
      "environment.exhaustion.rate_limit",
      "HTTP 429: too many requests — quota exceeded, retry after 60 seconds",
    ],
    [
      "environment.exhaustion.network",
      "ECONNREFUSED: connection refused by remote host at 10.0.0.1:443 — unable to connect",
    ],
    [
      "environment.exhaustion.malformed_response",
      "Invalid JSON: unexpected token '<' at position 0 — response body was malformed HTML",
    ],
    [
      "environment.exhaustion.context_overflow",
      "Error: Maximum context length exceeded — the input is too long for this model to process",
    ],
  ];

  for (const [leaf, errorText] of exhaustionCases) {
    it(`captures tool error for ${leaf}`, async () => {
      const toolName = "callApi";
      const apiTool = tool({
        description: "Call an external API.",
        inputSchema: z.object({ endpoint: z.string() }),
        execute: async () => errorText,
      });

      await generateText({
        model: singleToolCallThenAnswer(toolName, { endpoint: "/status" }),
        tools: { [toolName]: apiTool },
        stopWhen: stepCountIs(3),
        messages: [{ role: "user", content: "fetch status" }],
        experimental_telemetry: enableTelemetry(leaf),
      });

      await provider.forceFlush();
      const spans = stepSpans(exporter);
      expect(spans.length).toBe(2);

      const secondInput = parseJsonAttr(
        spans[1].attributes["gen_ai.input.messages"],
      ) as InputMessage[];
      const responses = toolResponses(secondInput);
      expect(responses.some((r) => r.includes(errorText))).toBe(true);
    });
  }

  // ── Execution loops ──────────────────────────────────────────────────────

  it("captures ≥3 identical tool calls for execution.loops.retry", async () => {
    // loops.retry counts ≥3 consecutive function_call entries with the same
    // tool name AND canonical-JSON-identical args. We drive 4 retries.
    const toolName = "pingServer";
    const args = { host: "api.example.com" };
    const pingTool = tool({
      description: "Ping a host.",
      inputSchema: z.object({ host: z.string() }),
      execute: async () => "Connection timed out after 30 seconds",
    });

    await generateText({
      model: repeatingToolCall(toolName, args, 4),
      tools: { [toolName]: pingTool },
      stopWhen: stepCountIs(6),
      messages: [{ role: "user", content: "ping it and retry" }],
      experimental_telemetry: enableTelemetry("execution.loops.retry"),
    });

    await provider.forceFlush();
    const spans = stepSpans(exporter);
    // 4 tool-call steps + 1 final text step.
    expect(spans.length).toBe(5);

    // The final step's input history should contain ≥3 tool responses, all
    // produced by identical-argument calls.
    const finalInput = parseJsonAttr(
      spans[spans.length - 1].attributes["gen_ai.input.messages"],
    ) as InputMessage[];
    const toolCallArgs: string[] = [];
    for (const m of finalInput) {
      for (const p of m.parts) {
        if (p.type === "tool_call" && p.name === toolName && p.arguments) {
          toolCallArgs.push(p.arguments);
        }
      }
    }
    expect(toolCallArgs.length).toBeGreaterThanOrEqual(3);
    // All argument payloads should be identical (retry, not drift).
    const unique = new Set(toolCallArgs);
    expect(unique.size).toBe(1);
  });

  it("captures ≥3 differing-arg tool calls for execution.loops.parameter_drift", async () => {
    const toolName = "searchDocs";
    const queries = ["auth", "login", "OAuth", "API keys"];
    const docsTool = tool({
      description: "Search docs.",
      inputSchema: z.object({ query: z.string() }),
      execute: async () => "No results found.",
    });

    await generateText({
      model: driftingToolCall(toolName, "query", queries),
      tools: { [toolName]: docsTool },
      stopWhen: stepCountIs(8),
      messages: [{ role: "user", content: "search the docs" }],
      experimental_telemetry: enableTelemetry(
        "execution.loops.parameter_drift",
      ),
    });

    await provider.forceFlush();
    const spans = stepSpans(exporter);
    expect(spans.length).toBe(queries.length + 1);

    const finalInput = parseJsonAttr(
      spans[spans.length - 1].attributes["gen_ai.input.messages"],
    ) as InputMessage[];
    const seenQueries = new Set<string>();
    for (const m of finalInput) {
      for (const p of m.parts) {
        if (p.type === "tool_call" && p.name === toolName && p.arguments) {
          const parsed = JSON.parse(p.arguments) as { query: string };
          seenQueries.add(parsed.query);
        }
      }
    }
    // ≥3 distinct argument values → parameter_drift territory.
    expect(seenQueries.size).toBeGreaterThanOrEqual(3);
  });
});
