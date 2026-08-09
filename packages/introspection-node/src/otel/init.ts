/**
 * One-liner bootstrap for the Introspection OTel surface.
 *
 * `init()` detects the installed LLM frameworks and wires them into one shared
 * pipeline, mirroring the Python SDK's `introspection.init()`:
 *
 * ```ts
 * import * as introspection from "@introspection-sdk/introspection-node/otel";
 *
 * await introspection.init({ serviceName: "my-app" });
 * // An installed Pi agent is wired into the shared provider automatically.
 * ```
 *
 * It also exposes the `track` / `feedback` / `identify` analytics surface and a
 * `conversation()` scope, proxied to a global {@link IntrospectionLogs}.
 */

import { type TracerProvider } from "@opentelemetry/api";
import {
  defaultResource,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import type {
  BasicTracerProvider,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

import type { AdvancedOptions, FeedbackOptions, UserTraits } from "../types.js";
import { DEFAULT_SERVICE_NAME, logger } from "../utils.js";
import {
  discoverIntegrations,
  setupIntegrations,
  teardownIntegrations,
  type Integration,
  type IntegrationHandles,
  type IntegrationSetupContext,
} from "./integrations/index.js";
import type { Agent } from "@earendil-works/pi-agent-core";

import type { AgentMeta } from "./pi.js";
import { IntrospectionLogs } from "./logs.js";
import { type ConflictBehavior, registerOTelGlobals } from "./setup.js";
import { IntrospectionSpanProcessor } from "./span-processor.js";

/** Options for {@link init}. */
export interface InitOptions {
  /** Auth token. Falls back to `INTROSPECTION_TOKEN`. */
  token?: string;
  /** Service name for spans. Falls back to `INTROSPECTION_SERVICE_NAME`. */
  serviceName?: string;
  /** OTLP base URL. Falls back to `INTROSPECTION_BASE_OTEL_URL`. */
  baseUrl?: string;
  /**
   * Use this provider instead of creating one. The caller owns its span
   * processors (attach an {@link IntrospectionSpanProcessor} yourself).
   */
  tracerProvider?: TracerProvider;
  /**
   * Extra span processors composed onto the provider `init()` creates — the
   * one-call dual-export path. Each runs alongside the Introspection processor,
   * e.g. `init({ spanProcessors: [new BatchSpanProcessor(otherBackendExporter)] })`.
   * Ignored when `tracerProvider` is supplied.
   */
  spanProcessors?: SpanProcessor[];
  /** Extra integrations to install beyond auto-discovery. */
  integrations?: Integration[];
  /** Install every importable built-in integration (default `true`). */
  autoDiscover?: boolean;
  /** Behaviour when an OTel context manager / propagator is already registered. */
  onConflict?: ConflictBehavior;
  /** Advanced configuration (custom exporter, headers, …). */
  advanced?: AdvancedOptions;
}

interface InitState {
  provider: TracerProvider | null;
  /**
   * The in-flight `init()`, if one has not settled yet.
   *
   * The `state.provider` guard alone is not enough: `init()` awaits framework
   * discovery and integration setup before assigning it, so two concurrent
   * callers both saw `null`, both built a provider plus a `LoggerProvider`
   * with its own batch-export timer, and the second overwrote the first --
   * leaking the first's exporters with nothing left to shut them down.
   */
  pending: Promise<TracerProvider> | null;
  ownsProvider: boolean;
  logs: IntrospectionLogs | null;
  handles: IntegrationHandles;
  shutdownRegistered: boolean;
}

const state: InitState = {
  provider: null,
  pending: null,
  ownsProvider: false,
  logs: null,
  handles: {},
  shutdownRegistered: false,
};

/** Generate a fresh conversation id (matches the Python SDK's format). */
export function newConversationId(): string {
  return `intro_conv_${crypto.randomUUID().replace(/-/g, "")}`;
}

function resolveProvider(
  options: InitOptions,
  token: string | undefined,
  serviceName: string | undefined,
  advanced: AdvancedOptions | undefined,
): TracerProvider {
  // baggage scopes (conversation/agent/identity) need these globals regardless
  // of who owns the provider.
  registerOTelGlobals(options.onConflict);

  if (options.tracerProvider) return options.tracerProvider;

  const provider = new NodeTracerProvider({
    // Merged onto the default resource, not substituted for it: a bare
    // `resourceFromAttributes` replaces `defaultResource()` outright, which
    // is where `telemetry.sdk.language` and the SDK version come from.
    //
    // Defaulted, because we are building this provider ourselves and the
    // logs stream beside it defaults to the same name. Only here: a caller
    // who passed their own `tracerProvider` returns above, and the span
    // processor still gets `serviceName` undefined so it leaves a provider
    // the caller already labelled alone.
    resource: defaultResource().merge(
      resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName ?? DEFAULT_SERVICE_NAME,
      }),
    ),
    // Order is irrelevant (IntrospectionSpanProcessor exports an isolated
    // converted copy and never mutates the shared span); listed first to match
    // setupTracing()'s ordering.
    spanProcessors: [
      new IntrospectionSpanProcessor({ token, serviceName, advanced }),
      ...(options.spanProcessors ?? []),
    ],
  });
  provider.register();
  return provider;
}

/**
 * Detect installed LLM frameworks and wire them into one shared provider.
 *
 * Idempotent: repeated calls return the already-configured provider without
 * re-installing integrations.
 */
export function init(options: InitOptions = {}): Promise<TracerProvider> {
  if (state.provider) {
    logger.debug("introspection.init() already called; returning provider");
    return Promise.resolve(state.provider);
  }
  if (state.pending) {
    logger.debug("introspection.init() already in flight; awaiting it");
    return state.pending;
  }
  // Cleared on both paths: on success the `state.provider` guard takes over,
  // and on failure a later init() has to be free to retry.
  const pending = initOnce(options).finally(() => {
    state.pending = null;
  });
  state.pending = pending;
  return pending;
}

async function initOnce(options: InitOptions): Promise<TracerProvider> {
  const token = options.token ?? process.env.INTROSPECTION_TOKEN;
  const serviceName =
    options.serviceName ?? process.env.INTROSPECTION_SERVICE_NAME ?? undefined;
  const baseUrl =
    options.baseUrl ?? process.env.INTROSPECTION_BASE_OTEL_URL ?? undefined;
  const advanced = options.advanced;

  // A custom span exporter (tests) stands in for a token; otherwise a token is
  // required for anything to be exported.
  if (!token && !advanced?.spanExporter && !options.tracerProvider) {
    throw new Error(
      "introspection.init() requires a token. Set INTROSPECTION_TOKEN or pass { token }.",
    );
  }

  const ownsProvider = !options.tracerProvider;
  const provider = resolveProvider(options, token, serviceName, advanced);

  // The track / feedback / identify surface is a separate OTLP log stream.
  const logs = new IntrospectionLogs({
    token,
    serviceName,
    baseOtelUrl: baseUrl,
    additionalHeaders: advanced?.additionalHeaders,
    flushInterval: advanced?.flushInterval,
    maxBatchSize: advanced?.maxBatchSize,
  });

  const ctx: IntegrationSetupContext = {
    tracerProvider: provider as BasicTracerProvider,
    token,
    serviceName,
    baseUrl,
    advanced,
    handles: state.handles,
  };

  // Run discovery + setup BEFORE committing global state, so a failure here
  // doesn't leave a half-configured provider behind the idempotency guard
  // (a later init() would otherwise return the broken provider and never retry).
  try {
    const toInstall: Integration[] = [];
    if (options.autoDiscover !== false) {
      toInstall.push(...(await discoverIntegrations()));
    }
    if (options.integrations) toInstall.push(...options.integrations);
    await setupIntegrations(toInstall, ctx);
  } catch (e) {
    state.handles = {};
    // The logs client owns a LoggerProvider with a batch export timer. It was
    // built before this try, so without shutting it down a failed init()
    // leaves that timer running with nothing referencing it.
    await logs.shutdown().catch(() => undefined);
    throw e;
  }

  state.provider = provider;
  state.ownsProvider = ownsProvider;
  state.logs = logs;

  if (!state.shutdownRegistered) {
    process.once("beforeExit", () => {
      void shutdown();
    });
    state.shutdownRegistered = true;
  }

  return provider;
}

/** Return the global logs client. Throws if {@link init} has not been called. */
export function getClient(): IntrospectionLogs {
  if (!state.logs) {
    throw new Error(
      "introspection.init() must be called before using track / feedback / identify.",
    );
  }
  return state.logs;
}

/** Return the shared provider. Throws if {@link init} has not been called. */
export function getTracerProvider(): TracerProvider {
  if (!state.provider) {
    throw new Error("introspection.init() must be called first.");
  }
  return state.provider;
}

/** Track an analytics event. Requires {@link init} first. */
export function track(
  eventName: string,
  properties?: Record<string, unknown>,
  options?: { eventId?: string },
): void {
  getClient().track(eventName, properties, options);
}

/** Record feedback on an AI response. Requires {@link init} first. */
export function feedback(name: string, options: FeedbackOptions = {}): void {
  getClient().feedback(name, options);
}

/** Associate the current context with a user. Requires {@link init} first. */
export function identify(
  userId: string,
  traits?: UserTraits,
  anonymousId?: string,
  eventId?: string,
): void {
  getClient().identify(userId, traits, anonymousId, eventId);
}

/**
 * Run `callback` inside a conversation scope: every span/event produced within
 * is stamped with `gen_ai.conversation.id`. Generates an id when none is given.
 *
 * ```ts
 * await introspection.conversation((id) => client.messages.create({ ... }));
 * await introspection.conversation("conv_123", (id) => run());
 * ```
 */
export function conversation<T>(
  callback: (conversationId: string) => T | Promise<T>,
): Promise<T>;
export function conversation<T>(
  conversationId: string,
  callback: (conversationId: string) => T | Promise<T>,
): Promise<T>;
export function conversation<T>(
  a: string | ((conversationId: string) => T | Promise<T>),
  b?: (conversationId: string) => T | Promise<T>,
): Promise<T> {
  const conversationId = typeof a === "string" ? a : newConversationId();
  const callback = (typeof a === "string" ? b : a) as (
    id: string,
  ) => T | Promise<T>;
  return getClient().withConversation(conversationId, undefined, () =>
    callback(conversationId),
  );
}

/**
 * Run `callback` with `gen_ai.agent.name` (+ optional `gen_ai.agent.id`) on the
 * baggage, so spans/events produced within are attributed to that agent.
 * Requires {@link init} first. Mirrors `IntrospectionLogs.withAgent`.
 */
export function withAgent<T>(
  agentName: string,
  agentId: string | undefined,
  callback: () => T | Promise<T>,
): Promise<T> {
  return getClient().withAgent(agentName, agentId, callback);
}

/**
 * Run `callback` inside a conversation scope, optionally chaining a previous
 * response id. Unlike {@link conversation}, the id is required (no auto-gen).
 * Requires {@link init} first.
 */
export function withConversation<T>(
  conversationId: string | undefined,
  previousResponseId: string | undefined,
  callback: () => T | Promise<T>,
): Promise<T> {
  return getClient().withConversation(
    conversationId,
    previousResponseId,
    callback,
  );
}

/** Run `callback` with `identity.user_id` on the baggage. Requires {@link init} first. */
export function withUserId<T>(
  userId: string,
  callback: () => T | Promise<T>,
): Promise<T> {
  return getClient().withUserId(userId, callback);
}

/** Run `callback` with `identity.anonymous_id` on the baggage. Requires {@link init} first. */
export function withAnonymousId<T>(
  anonymousId: string,
  callback: () => T | Promise<T>,
): Promise<T> {
  return getClient().withAnonymousId(anonymousId, callback);
}

/** Instrument a Pi `Agent` against the shared provider. Requires {@link init}. */
export function instrumentPi(agent: Agent, meta: AgentMeta): void {
  const instrumentor = state.handles.piInstrumentor;
  if (!instrumentor) {
    throw new Error(
      "Pi integration not configured. Call introspection.init() with @earendil-works/pi-agent-core installed.",
    );
  }
  instrumentor.instrument(agent, meta);
}

/**
 * Flush and shut down the logs client and, if `init()` created it, the
 * provider.
 *
 * A provider you passed via `init({ tracerProvider })` is **yours** — this
 * leaves it running, so any processors you attached to it (a second
 * OTLP backend, for instance) are not flushed. Call `provider.shutdown()`
 * yourself after this.
 */
export async function shutdown(): Promise<void> {
  const { logs, provider, ownsProvider } = state;
  if (logs) {
    try {
      await logs.shutdown();
    } catch (e) {
      logger.debug(`Error shutting down logs client: ${String(e)}`);
    }
  }
  if (ownsProvider && provider && "shutdown" in provider) {
    try {
      await (provider as { shutdown(): Promise<void> }).shutdown();
    } catch (e) {
      logger.debug(`Error shutting down provider: ${String(e)}`);
    }
  }
  // Run integration teardowns + clear the
  // run-once guard so a later init() re-installs and rebuilds the handles
  // against the new provider instead of being skipped.
  teardownIntegrations();
  state.provider = null;
  state.ownsProvider = false;
  state.logs = null;
  state.handles = {};
}

/** Reset module state. Test-only utility. */
export function _resetForTests(): void {
  teardownIntegrations();
  state.provider = null;
  state.pending = null;
  state.ownsProvider = false;
  state.logs = null;
  state.handles = {};
}
