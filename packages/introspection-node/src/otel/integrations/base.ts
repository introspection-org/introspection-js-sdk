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

export const OPTIONAL_PEERS = {
  anthropic: "@anthropic-ai/sdk",
  claudeAgent: "@anthropic-ai/claude-agent-sdk",
  gemini: "@google/genai",
  langchainCallbacks: "@langchain/core/callbacks/base",
  mastraObservability: "@mastra/observability",
  openaiAgents: "@openai/agents",
  piAgentCore: "@earendil-works/pi-agent-core",
  vercelAi: "ai",
} as const;

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
 * Distinguish "framework package not installed" (expected — skip quietly) from
 * a real error inside an installed integration (a bug we shouldn't hide).
 */
export function isModuleNotFound(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
    return true;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return /Cannot find (module|package)|Failed to resolve/i.test(msg);
}

/**
 * Import an optional peer without leaving a static import edge for bundlers.
 * Keep the `import()` argument variable-based: built-in framework integrations
 * use this so importing `@introspection-sdk/introspection-node/otel` does not
 * require every optional framework SDK to be installed.
 */
export async function importOptionalPeer<T = unknown>(
  specifier: string,
): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch (e) {
    if (isModuleNotFound(e)) {
      throw new DidNotEnable(`Optional peer ${specifier} is not installed`);
    }
    throw e;
  }
}

export async function isOptionalPeerInstalled(
  specifier: (typeof OPTIONAL_PEERS)[keyof typeof OPTIONAL_PEERS],
): Promise<boolean> {
  try {
    await importOptionalPeer(specifier);
    return true;
  } catch (e) {
    if (e instanceof DidNotEnable) return false;
    throw e;
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
  /**
   * Optional availability probe for built-in integrations backed by optional
   * peer packages. Missing peers should return false so their `deactivates`
   * rules do not affect installed integrations.
   */
  isAvailable?(): boolean | Promise<boolean>;
  /**
   * Wire the framework into the shared pipeline. Runs once; may throw
   * {@link DidNotEnable}. May return a teardown callback (e.g. to uninstrument a
   * prototype patch) that `introspection.shutdown()` runs so a later `init()`
   * re-installs cleanly against the rebuilt provider.
   */
  setupOnce(
    ctx: IntegrationSetupContext,
  ): void | (() => void) | Promise<void | (() => void)>;
}
