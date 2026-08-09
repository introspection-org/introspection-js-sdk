/**
 * Pi chat spans — real Agent, real Anthropic response, Polly cassette.
 *
 * The unit tests in `test-pi-attributes.test.ts` prove the attribute builders
 * against hand-built `AssistantMessage`s. This file proves the other half:
 * that a real pi run, streaming a real provider response through
 * `IntrospectionPiInstrumentor`, actually produces that attribute set. A
 * change in pi's event ordering or in Anthropic's stream shape fails here and
 * nowhere else.
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
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import type { Polly } from "@pollyjs/core";

import { IntrospectionPiInstrumentor } from "@introspection-sdk/introspection-node/otel";
import type {
  InputMessage,
  OutputMessage,
} from "@introspection-sdk/introspection-pi";
import {
  setupPolly,
  ensureEnvVarsForReplay,
  installTestOTelGlobals,
} from "../polly-setup";
import {
  MODEL_KEY,
  jsonAttr,
  makeAgent,
  piTracing,
  type PiTracing,
} from "./pi-fixtures";

const RECORDING = "pi-chat";
const SYSTEM_PROMPT =
  "You are a terse assistant. Answer in one short sentence.";

describe("Pi chat spans — real Agent against a Polly-recorded Anthropic call", () => {
  let polly: Polly | null = null;
  let tracing: PiTracing | null = null;
  let instrumentor: IntrospectionPiInstrumentor | null = null;
  let disposeOTel: (() => void) | null = null;

  // One Polly per file — its interception is global, not per-test.
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
  });

  async function runOnce(prompt: string) {
    const agent = await makeAgent({ systemPrompt: SYSTEM_PROMPT });
    instrumentor!.instrument(agent, {
      conversationId: "pi-chat-conv",
      agentId: "pi-chat-agent",
      agentName: "Chat",
    });
    await agent.prompt(prompt);
    await tracing!.provider.forceFlush();
    const chats = tracing!.spansFor("chat");
    expect(chats).toHaveLength(1);
    return chats[0]!;
  }

  it("emits one CLIENT chat span carrying the full GenAI request identity", async () => {
    if (!polly) return;
    const span = await runOnce("Name the first three prime numbers.");

    expect(span.name).toBe(`chat ${MODEL_KEY}`);
    expect(span.kind).toBe(SpanKind.CLIENT);
    // A completed generation asserts nothing about quality — status stays Unset.
    expect(span.status.code).toBe(SpanStatusCode.UNSET);

    expect(span.attributes["gen_ai.operation.name"]).toBe("chat");
    expect(span.attributes["gen_ai.provider.name"]).toBe("anthropic");
    expect(span.attributes["gen_ai.request.model"]).toBe(MODEL_KEY);
    expect(span.attributes["gen_ai.request.stream"]).toBe(true);
    expect(span.attributes["gen_ai.conversation.id"]).toBe("pi-chat-conv");
    expect(span.attributes["gen_ai.agent.id"]).toBe("pi-chat-agent");
    expect(span.attributes["gen_ai.agent.name"]).toBe("Chat");
    expect(span.attributes["server.address"]).toBe("api.anthropic.com");
    expect(span.attributes["server.port"]).toBe(443);

    // gen_ai.system is the pre-1.30 spelling — the processor drops it so
    // consumers never see both spellings on one span.
    expect(span.attributes["gen_ai.system"]).toBeUndefined();
  });

  it("records the provider's own response identity and token usage", async () => {
    if (!polly) return;
    const span = await runOnce("Name the first three prime numbers.");

    // Response model is what the provider resolved the alias to, which is
    // not necessarily the requested id.
    expect(span.attributes["gen_ai.response.model"]).toEqual(
      expect.stringContaining("haiku"),
    );
    expect(span.attributes["gen_ai.response.id"]).toEqual(
      expect.stringMatching(/^msg_/),
    );
    expect(span.attributes["gen_ai.response.finish_reasons"]).toEqual(["stop"]);

    expect(span.attributes["gen_ai.usage.input_tokens"]).toBeGreaterThan(0);
    expect(span.attributes["gen_ai.usage.output_tokens"]).toBeGreaterThan(0);

    // Streaming timing is measured from the real event stream, so it only
    // exists when chunks actually arrived.
    expect(span.attributes["gen_ai.response.time_to_first_chunk"]).toBeTypeOf(
      "number",
    );
  });

  it("serializes the prompt and the completion as semconv message arrays", async () => {
    if (!polly) return;
    const span = await runOnce("Name the first three prime numbers.");

    const instructions = jsonAttr<Array<{ type: string; content: string }>>(
      span,
      "gen_ai.system_instructions",
    );
    expect(instructions).toEqual([{ type: "text", content: SYSTEM_PROMPT }]);

    const input = jsonAttr<InputMessage[]>(span, "gen_ai.input.messages");
    expect(input).toEqual([
      {
        role: "user",
        parts: [
          { type: "text", content: "Name the first three prime numbers." },
        ],
      },
    ]);

    const output = jsonAttr<OutputMessage[]>(span, "gen_ai.output.messages");
    expect(output).toHaveLength(1);
    expect(output[0]!.role).toBe("assistant");
    expect(output[0]!.finish_reason).toBe("stop");
    const text = output[0]!.parts.find((p) => p.type === "text");
    expect(text).toBeDefined();
    // The recorded answer is a real completion — assert it carries the
    // content rather than pinning the model's exact wording.
    expect((text as { content: string }).content).toMatch(/2|two/i);
  });

  it("keeps a multi-turn conversation on one span per LLM call", async () => {
    if (!polly) return;
    const agent = await makeAgent({ systemPrompt: SYSTEM_PROMPT });
    instrumentor!.instrument(agent, {
      conversationId: "pi-chat-conv",
      agentId: "pi-chat-agent",
      agentName: "Chat",
    });

    await agent.prompt("Name the first three prime numbers.");
    await agent.prompt("Now add them together.");
    await tracing!.provider.forceFlush();

    const chats = tracing!.spansFor("chat");
    expect(chats).toHaveLength(2);

    // Turn 2 carries the whole prior transcript, so the durable conversation
    // can be rebuilt from the last span alone.
    const second = jsonAttr<InputMessage[]>(chats[1]!, "gen_ai.input.messages");
    expect(second.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(second).toHaveLength(3);

    // Each prompt is its own root — pi's Agent has no run span unless the
    // caller opts into one (see test-pi-recorded-run.test.ts).
    expect(new Set(chats.map((s) => s.spanContext().traceId)).size).toBe(2);
  });
});
