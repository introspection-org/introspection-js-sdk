/**
 * Integration base contract, modeled on Sentry's integration registry.
 *
 * An {@link Integration} knows how to wire one framework (currently Pi) into
 * the shared Introspection trace pipeline. `init()`
 * discovers the integrations whose framework is importable and runs each
 * `setupOnce()` exactly once.
 */

import type { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";

import type { AdvancedOptions } from "../../types.js";
import type { IntrospectionPiInstrumentor } from "../pi.js";

export const OPTIONAL_PEERS = {
  piAgentCore: "@earendil-works/pi-agent-core",
} as const;

/**
 * Bound framework handles published by instance/config-based integrations.
 *
 * Some JS framework hooks cannot be wired globally — the caller still has to
 * instrument an Agent instance. For those, the integration publishes a handle
 * here, pre-bound to the `init()` token / provider, and `init()` re-exposes it
 * (e.g. `introspection.instrumentPi()`).
 */
export interface IntegrationHandles {
  piInstrumentor?: IntrospectionPiInstrumentor;
}

/**
 * Thrown by an integration module/`setupOnce` when the framework cannot be
 * activated (package missing, version too old, …).
 *
 * Always swallowed by `setupIntegrations`, whether the integration was
 * auto-discovered or requested explicitly — a framework that cannot activate
 * skips its shim. Any other error propagates.
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
 * Instrumentors that emit onto the shared `TracerProvider` (currently Pi) use
 * `tracerProvider`; hooks that own their own OTLP export pipeline only need
 * the `token` / `serviceName` / `baseUrl`.
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
  /** Stable identifier used for the run-once guard. */
  readonly identifier: string;
  /**
   * Optional availability probe for built-in integrations backed by optional
   * peer packages. Missing peers should return false so the integration is
   * skipped quietly.
   */
  isAvailable?(): boolean | Promise<boolean>;
  /**
   * Wire the framework into the shared pipeline. Runs once; may throw
   * {@link DidNotEnable}. May return a teardown callback (e.g. to detach a
   * framework hook) that `introspection.shutdown()` runs so a later `init()`
   * re-installs cleanly against the rebuilt provider.
   */
  setupOnce(
    ctx: IntegrationSetupContext,
  ): void | (() => void) | Promise<void | (() => void)>;
}
