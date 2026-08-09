/**
 * Pi error and cancellation paths — real Agent, Polly cassette.
 *
 * Two outcomes that must never be confused with each other, and that hand-
 * built error messages can't distinguish: a real provider rejection (span
 * status ERROR, `error.type`, recorded exception) and a caller-requested
 * abort (status Unset, `introspection.termination_reason`, no exception).
 * The first is recorded from a real Anthropic 404; the second is a real
 * AbortSignal fired mid-generation against the recorded stream.
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
import { SpanStatusCode } from "@opentelemetry/api";
import type { Polly } from "@pollyjs/core";

import { IntrospectionPiInstrumentor } from "@introspection-sdk/introspection-node/otel";
import {
  setupPolly,
  ensureEnvVarsForReplay,
  installTestOTelGlobals,
} from "../polly-setup";
import { makeAgent, makeModel, piTracing, type PiTracing } from "./pi-fixtures";

const RECORDING = "pi-errors";

describe("Pi failure paths — real Agent against a Polly-recorded Anthropic error", () => {
  let polly: Polly | null = null;
  let tracing: PiTracing | null = null;
  let instrumentor: IntrospectionPiInstrumentor | null = null;
  let disposeOTel: (() => void) | null = null;

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

  it("marks the chat span as failed when the provider rejects the request", async () => {
    if (!polly) return;

    // A model id the account cannot serve — Anthropic answers 404
    // not_found_error, which pi surfaces as a stopReason "error" message
    // rather than a thrown exception.
    const model = { ...(await makeModel()), id: "claude-not-a-real-model" };
    const agent = await makeAgent({ model });
    instrumentor!.instrument(agent, {
      conversationId: "pi-errors-conv",
      agentId: "pi-errors-agent",
      agentName: "Broken",
    });

    await agent.prompt("Say hello.");
    await tracing!.provider.forceFlush();

    const chats = tracing!.spansFor("chat");
    expect(chats).toHaveLength(1);
    const span = chats[0]!;

    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBeTruthy();
    expect(span.attributes["error.type"]).toBeTypeOf("string");
    expect(span.attributes["gen_ai.response.finish_reasons"]).toEqual([
      "error",
    ]);

    // A failed call is not a cancellation.
    expect(span.attributes["introspection.termination_reason"]).toBeUndefined();

    // The exception is recorded as a span event, so the message survives
    // even for backends that drop span status descriptions.
    const exception = span.events.find((e) => e.name === "exception");
    expect(exception).toBeDefined();

    // Request identity still lands — a failure must remain attributable.
    expect(span.attributes["gen_ai.request.model"]).toBe(
      "claude-not-a-real-model",
    );
    expect(span.attributes["gen_ai.conversation.id"]).toBe("pi-errors-conv");
    expect(span.attributes["gen_ai.usage.output_tokens"]).toBe(0);
  });

  it("treats a caller-requested abort as an outcome, not a failure", async () => {
    if (!polly) return;

    const agent = await makeAgent({
      systemPrompt: "Answer in one short sentence.",
    });
    instrumentor!.instrument(agent, {
      conversationId: "pi-errors-conv",
      agentId: "pi-errors-agent",
      agentName: "Cancelled",
    });

    // Abort once the model is genuinely mid-generation — pi owns the
    // AbortSignal, so this is the real cancellation path a host triggers on a
    // stop button, cutting a live token stream rather than a request that
    // never started.
    agent.subscribe((event) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        agent.abort();
      }
    });

    await agent
      .prompt("Count slowly from one to twenty, in words.")
      .catch(() => undefined);
    await tracing!.provider.forceFlush();

    const span = tracing!.spansFor("chat")[0];
    expect(span).toBeDefined();

    // Status stays Unset: we assert neither success over a truncated
    // generation nor an error the host asked for.
    expect(span!.status.code).toBe(SpanStatusCode.UNSET);
    expect(span!.attributes["introspection.termination_reason"]).toBe(
      "cancelled",
    );
    expect(span!.attributes["error.type"]).toBeUndefined();
    expect(span!.events.find((e) => e.name === "exception")).toBeUndefined();
    expect(span!.attributes["gen_ai.response.finish_reasons"]).toEqual([
      "aborted",
    ]);
  });
});
