/**
 * High-level pi Agent SDK integration for Introspection.
 *
 * Wraps {@link @introspection-sdk/introspection-pi} behind a zero-config
 * interface so users don't need to manage OpenTelemetry tracers directly.
 *
 * @example
 * ```ts
 * import { IntrospectionPiInstrumentor, setupTracing } from "@introspection-sdk/introspection-node";
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
import type { Agent } from "@earendil-works/pi-agent-core";
import {
  instrumentStream,
  instrumentAgent,
  type AgentMeta,
  type AgentInstrumentation,
} from "@introspection-sdk/introspection-pi";
import { VERSION } from "../version.js";

export type { AgentMeta } from "@introspection-sdk/introspection-pi";

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
  private _instrumentations: AgentInstrumentation[] = [];

  constructor(opts: IntrospectionPiInstrumentorOptions = {}) {
    this._tracer = trace.getTracer(
      opts.tracerName ?? "introspection-pi",
      VERSION,
    );
  }

  /**
   * Instrument a pi {@link Agent}:
   * - Wraps `agent.streamFn` to emit a `chat ${provider}` span per LLM call.
   * - Subscribes to the agent loop to emit an `execute_tool ${name}` span per
   *   tool execution.
   *
   * @param agent - The pi Agent instance to instrument.
   * @param meta  - Identity metadata stamped on every span produced by this agent.
   */
  instrument(agent: Agent, meta: AgentMeta): void {
    agent.streamFn = instrumentStream(agent.streamFn, {
      tracer: this._tracer,
      meta,
    });
    this._instrumentations.push(
      instrumentAgent(agent, { tracer: this._tracer, meta }),
    );
  }

  /**
   * Unsubscribe all active tool instrumentations and finalize any open spans.
   */
  stop(): void {
    for (const inst of this._instrumentations) inst.stop();
    this._instrumentations = [];
  }
}
