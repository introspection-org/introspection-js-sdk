/**
 * One-call tracing bootstrap for Introspection.
 *
 * Wires up the three things every host process needs for baggage-based
 * agent / conversation propagation to work:
 *
 * 1. `AsyncLocalStorageContextManager` — without this, `context.with()` is a
 *    no-op (the default `NOOP_CONTEXT_MANAGER` silently drops the context),
 *    which makes `IntrospectionClient.withAgent()`, `.withConversation()`,
 *    etc. dead code.
 * 2. `W3CBaggagePropagator` — so baggage is carried across HTTP boundaries
 *    via the `baggage` header (alongside W3C trace-context).
 * 3. A registered `NodeTracerProvider` with an `IntrospectionSpanProcessor`
 *    on it — so spans are exported to Introspection and baggage values
 *    (conversation / agent IDs) are merged into span attributes at
 *    `onEnd()` time.
 *
 * Call this once at process start (before any instrumentors run). It is
 * idempotent across re-invocations — the cached provider is returned and
 * the global registrations are not touched a second time.
 *
 * **Loud-by-default registration.** OTel's `setGlobalContextManager` /
 * `setGlobalPropagator` silently refuse to replace an existing
 * registration. If anything (another lib, a stale call, a test fixture)
 * has already installed a context manager that does NOT propagate W3C
 * baggage, our `withAgent` / `withConversation` calls become silent
 * no-ops and users get spans with no identity attached — exactly the
 * footgun this SDK exists to prevent.
 *
 * `setupTracing` defends against that:
 *   - If no manager / propagator is registered: install ours.
 *   - If one is registered: WARN (default) or THROW (strict mode) so the
 *     host author sees it, rather than discovering missing baggage in
 *     production telemetry weeks later.
 *
 * Pass `{ onConflict: "throw" }` (or set `INTROSPECTION_STRICT_TRACING=1`
 * in the env) for the strict variant. Pass `{ onConflict: "replace" }`
 * to force replacement when you know the prior registration is wrong
 * (e.g. test setup, or migrating from another tracer).
 *
 * @example
 * ```ts
 * import { setupTracing, IntrospectionClient } from "@introspection-sdk/introspection-node";
 *
 * setupTracing();
 *
 * const introspect = new IntrospectionClient();
 *
 * await introspect.withAgent("researcher", "researcher-1", () =>
 *   introspect.withConversation(conversationId, undefined, () =>
 *     client.messages.create({ ... }),
 *   ),
 * );
 * ```
 */
import { context, propagation } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";

import { logger } from "../utils.js";
import {
  IntrospectionSpanProcessor,
  type IntrospectionSpanProcessorOptions,
} from "./span-processor.js";

let registeredProvider: NodeTracerProvider | undefined;

export type ConflictBehavior = "warn" | "throw" | "replace";

export interface SetupTracingOptions extends IntrospectionSpanProcessorOptions {
  /**
   * What to do if a context manager or propagator is already registered.
   *
   *   - `"warn"`  (default) — log a warning and continue with the existing
   *     registration. Spans still flow but baggage may not propagate as
   *     expected. Set `INTROSPECTION_STRICT_TRACING=1` to upgrade to throw.
   *   - `"throw"` — throw an error. Use in environments where a silent
   *     baggage drop is unacceptable (production telemetry pipelines).
   *   - `"replace"` — force-register over the existing manager / propagator.
   *     Useful in tests or when migrating from another tracer; can break
   *     other libraries that relied on the previous registration.
   */
  onConflict?: ConflictBehavior;
}

function defaultConflictBehavior(): ConflictBehavior {
  return process.env.INTROSPECTION_STRICT_TRACING ? "throw" : "warn";
}

function registerContextManager(behavior: ConflictBehavior): void {
  const ok = context.setGlobalContextManager(
    new AsyncLocalStorageContextManager().enable(),
  );
  if (ok) return;
  // OTel silently refuses replacement — we have to disable+retry to force.
  const msg =
    "setupTracing: another OTel context manager was already registered. " +
    "withAgent / withConversation baggage scopes will not propagate unless " +
    "that manager is an AsyncLocalStorageContextManager honoring W3C baggage.";
  if (behavior === "throw") {
    throw new Error(`[introspection] ${msg}`);
  }
  if (behavior === "replace") {
    context.disable();
    if (
      !context.setGlobalContextManager(
        new AsyncLocalStorageContextManager().enable(),
      )
    ) {
      throw new Error(
        "[introspection] setupTracing: failed to replace context manager " +
          "even after disable(); the OTel global registry is in a bad state.",
      );
    }
    return;
  }
  logger.warn(msg);
}

function registerPropagator(behavior: ConflictBehavior): void {
  const propagator = new CompositePropagator({
    propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
  });
  const ok = propagation.setGlobalPropagator(propagator);
  if (ok) return;
  const msg =
    "setupTracing: another OTel propagator was already registered. " +
    "Cross-process baggage propagation depends on the existing propagator " +
    "carrying the W3C `baggage` header.";
  if (behavior === "throw") {
    throw new Error(`[introspection] ${msg}`);
  }
  if (behavior === "replace") {
    propagation.disable();
    if (!propagation.setGlobalPropagator(propagator)) {
      throw new Error(
        "[introspection] setupTracing: failed to replace propagator even " +
          "after disable(); the OTel global registry is in a bad state.",
      );
    }
    return;
  }
  logger.warn(msg);
}

/**
 * Initialise Introspection tracing for a Node.js process.
 */
export function setupTracing(
  options?: SetupTracingOptions,
): NodeTracerProvider {
  if (registeredProvider) {
    return registeredProvider;
  }

  const behavior: ConflictBehavior =
    options?.onConflict ?? defaultConflictBehavior();

  registerContextManager(behavior);
  registerPropagator(behavior);

  const provider = new NodeTracerProvider({
    spanProcessors: [new IntrospectionSpanProcessor(options)],
  });
  provider.register();

  registeredProvider = provider;
  return provider;
}
