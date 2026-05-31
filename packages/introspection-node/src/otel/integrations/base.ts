/**
 * Integration base contract, modeled on Sentry's integration registry and the
 * Python SDK's `Integration` ABC.
 *
 * An {@link Integration} knows how to wire one framework (Anthropic, Gemini,
 * OpenAI Agents, …) into the shared Introspection trace pipeline. `init()`
 * discovers the integrations whose framework is importable and runs each
 * `setupOnce()` exactly once.
 */

import type { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";

import type { AdvancedOptions } from "../../types.js";
import type { InstrumentedClaudeAgentSDK } from "../claude-wrapper.js";
import type { IntrospectionCallbackHandler } from "../langchain-handler.js";
import type { IntrospectionPiInstrumentor } from "../pi.js";

/**
 * Bound framework handles published by instance/config-based integrations.
 *
 * Some JS framework hooks cannot be wired globally — the caller still has to
 * pass a handler to `chain.invoke({ callbacks })`, put an exporter in the
 * Mastra config, instrument an Agent instance, or wrap the Claude Agent SDK
 * module. For those, the integration publishes a handle here, pre-bound to the
 * `init()` token / provider, and `init()` re-exposes it (e.g.
 * `introspection.getLangchainHandler()`).
 */
export interface IntegrationHandles {
  langchainHandler?: IntrospectionCallbackHandler;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mastraExporter?: any;
  piInstrumentor?: IntrospectionPiInstrumentor;
  instrumentClaudeAgent?: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sdk: any,
  ) => InstrumentedClaudeAgentSDK;
}

/**
 * Thrown by an integration module/`setupOnce` when the framework cannot be
 * activated (package missing, version too old, …).
 *
 * Swallowed during auto-discovery so a missing framework just skips its shim;
 * re-raised only when an integration is requested explicitly.
 */
export class DidNotEnable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DidNotEnable";
  }
}

/**
 * Everything an integration needs to wire itself into the shared pipeline.
 *
 * Most JS framework hooks (the OpenAI Agents processor, the LangChain handler,
 * the Mastra exporter) own their own OTLP export pipeline and only need the
 * `token` / `serviceName` / `baseUrl`. Instrumentors that emit onto the shared
 * `TracerProvider` (Anthropic, Gemini, Vercel AI SDK, Pi) use `tracerProvider`.
 */
export interface IntegrationSetupContext {
  /** The shared provider built (or adopted) by `init()`. */
  tracerProvider: BasicTracerProvider;
  /** Auth token resolved by `init()` (arg → env). */
  token?: string;
  /** Service name resolved by `init()`. */
  serviceName?: string;
  /** OTLP base URL resolved by `init()`. */
  baseUrl?: string;
  /** Advanced options (custom exporter for tests, headers, …). */
  advanced?: AdvancedOptions;
  /** Mutable bag for integrations to publish pre-bound framework handles. */
  handles: IntegrationHandles;
}

/**
 * A framework integration. Each built-in integration is a singleton object;
 * users may also pass custom integrations to `init({ integrations: [...] })`.
 */
export interface Integration {
  /** Stable identifier used for the run-once guard and `deactivates`. */
  readonly identifier: string;
  /**
   * Identifiers of other integrations to disable when this one is active, so a
   * wrapping framework (e.g. LangChain) does not double-trace the SDK it wraps.
   */
  readonly deactivates?: readonly string[];
  /** Wire the framework into the shared pipeline. Runs once; may throw {@link DidNotEnable}. */
  setupOnce(ctx: IntegrationSetupContext): void;
}
