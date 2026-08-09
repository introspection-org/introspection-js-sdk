/**
 * High-level pi Agent SDK integration for Introspection.
 *
 * Wraps {@link @introspection-sdk/introspection-pi} behind a zero-config
 * interface so users don't need to manage OpenTelemetry tracers directly.
 *
 * @example
 * ```ts
 * import { IntrospectionPiInstrumentor, setupTracing } from "@introspection-sdk/introspection-node/otel";
 * import { Agent } from "@earendil-works/pi-agent-core";
 *
 * setupTracing({ serviceName: "my-app" });
 * const instrumentor = new IntrospectionPiInstrumentor();
 *
 * const agent = new Agent({ ... });
 * instrumentor.instrument(agent, {
 *   conversationId: "conv-123",
 *   agentId: "weather-agent",
 *   agentName: "Weather",
 * });
 *
 * await agent.prompt("What's the weather in Tokyo?");
 * instrumentor.stop();
 * ```
 */

import { trace } from "@opentelemetry/api";
import type { Agent, StreamFn } from "@earendil-works/pi-agent-core";
import {
  instrumentStream,
  instrumentAgent,
  type AgentMeta,
  type AgentInstrumentation,
} from "@introspection-sdk/introspection-pi";
import { VERSION } from "../version.js";

export type {
  AgentMeta,
  // Alias kept from when this lived on the /otel barrel.
  AgentMeta as PiAgentMeta,
} from "@introspection-sdk/introspection-pi";

export interface IntrospectionPiInstrumentorOptions {
  /** Tracer name used for all spans produced by this instrumentor. */
  tracerName?: string;
}

/**
 * Zero-config pi Agent SDK integration for Introspection.
 *
 * Uses the global OTel tracer provider (registered by {@link setupTracing}).
 * Call {@link instrument} once per {@link Agent} instance, then {@link stop}
 * to unsubscribe all tool instrumentation and finalize open spans.
 */
export class IntrospectionPiInstrumentor {
  private _tracer: ReturnType<typeof trace.getTracer>;
  /** Per instrumented agent: its loop subscription and how to unwrap it. */
  private _active = new Map<
    Agent,
    { instrumentation: AgentInstrumentation; restore: () => void }
  >();

  constructor(opts: IntrospectionPiInstrumentorOptions = {}) {
    this._tracer = trace.getTracer(
      opts.tracerName ?? "introspection-pi",
      VERSION,
    );
  }

  /**
   * Instrument a pi {@link Agent}:
   * - Wraps the agent stream function to emit a `chat ${model}` span per
   *   LLM call.
   * - Subscribes to the agent loop to emit an `execute_tool ${name}` span per
   *   tool execution.
   *
   * Re-instrumenting an agent replaces its previous instrumentation rather
   * than stacking on top. `AgentMeta` carries the conversation id, so a host
   * reusing one `Agent` across conversations calls this again by design;
   * without the replace, the stream was wrapped twice and `subscribe` fired
   * twice, so every call produced two `chat` spans and two `execute_tool`
   * spans, the inner pair stamped with the previous conversation.
   *
   * @param agent - The pi Agent instance to instrument.
   * @param meta  - Identity metadata stamped on every span produced by this agent.
   */
  instrument(agent: Agent, meta: AgentMeta): void {
    this._detach(agent);

    const key = "streamFunction" in agent ? "streamFunction" : "streamFn";
    const instrumentable = agent as unknown as Record<
      "streamFunction" | "streamFn",
      StreamFn
    >;
    const original = instrumentable[key];
    instrumentable[key] = instrumentStream(original, {
      tracer: this._tracer,
      meta,
    });
    this._active.set(agent, {
      instrumentation: instrumentAgent(agent, {
        tracer: this._tracer,
        meta,
      }),
      restore: () => {
        instrumentable[key] = original;
      },
    });
  }

  /**
   * Unsubscribe all active tool instrumentations, finalize any open spans, and
   * put each agent's original stream function back.
   *
   * Restoring matters: without it a stopped instrumentor's agents kept
   * emitting `chat` spans onto a provider that had already been shut down.
   */
  stop(): void {
    for (const agent of [...this._active.keys()]) this._detach(agent);
  }

  private _detach(agent: Agent): void {
    const active = this._active.get(agent);
    if (!active) return;
    active.instrumentation.stop();
    active.restore();
    this._active.delete(agent);
  }
}
