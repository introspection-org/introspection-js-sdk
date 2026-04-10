/**
 * Claude Agent SDK Wrapper
 *
 * Provides a zero-friction `withIntrospection()` wrapper for the Claude Agent SDK.
 * Automatically instruments all query() calls with OpenTelemetry tracing via
 * IntrospectionClaudeHooks — no manual hook wiring or recordUsage() calls needed.
 *
 * @example
 * ```typescript
 * import * as sdk from "@anthropic-ai/claude-agent-sdk";
 * import { withIntrospection } from "@introspection-sdk/introspection-node";
 *
 * const tracedSdk = withIntrospection(sdk, { serviceName: "my-agent" });
 *
 * for await (const message of tracedSdk.query({ prompt: "Hello" })) {
 *   // messages yielded normally — tracing happens automatically
 * }
 *
 * await tracedSdk.shutdown();
 * ```
 */

import {
  IntrospectionClaudeHooks,
  type IntrospectionClaudeHooksOptions,
  type ClaudeHooksConfig,
  type ClaudeSDKMessage,
} from "./claude-hooks.js";
import { logger } from "./utils.js";

// --- Public types ---

/**
 * Configuration for {@link withIntrospection}.
 *
 * Alias of {@link IntrospectionClaudeHooksOptions}.
 */
export type WithIntrospectionOptions = IntrospectionClaudeHooksOptions;

/**
 * Minimal interface for the Claude Agent SDK module.
 * Accepts `import * as sdk from "@anthropic-ai/claude-agent-sdk"`.
 *
 * Uses `any` for the query signature to accept any SDK version's types
 * without requiring the SDK as a compile-time dependency.
 */
export interface ClaudeAgentSDKModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: (...args: any[]) => any;
  [key: string]: unknown;
}

/**
 * The instrumented SDK returned by {@link withIntrospection}.
 *
 * Exposes the same surface as the original SDK module plus tracing helpers.
 */
export interface InstrumentedClaudeAgentSDK {
  /** Instrumented `query()` — auto-captures prompt, hooks, and usage. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: (...args: any[]) => any;
  /**
   * Flush pending spans without shutting down.
   *
   * @returns A promise that resolves once the flush completes.
   */
  forceFlush(): Promise<void>;
  /**
   * Shut down tracing and flush all pending spans.
   *
   * @returns A promise that resolves once shutdown is complete.
   */
  shutdown(): Promise<void>;
  /** The underlying {@link IntrospectionClaudeHooks} instance for advanced usage. */
  readonly hooks: IntrospectionClaudeHooks;
  /** All other SDK exports pass through unchanged. */
  [key: string]: unknown;
}

// --- Implementation ---

/**
 * Wrap the Claude Agent SDK module to automatically instrument every
 * `query()` call with OpenTelemetry tracing.
 *
 * The returned SDK:
 * - Auto-captures `prompt` and `systemPrompt` from query params
 * - Injects instrumentation hooks (merged with any user-provided hooks)
 * - Calls {@link IntrospectionClaudeHooks.recordUsage | recordUsage()} on
 *   every streamed message automatically
 * - Flushes spans when each query stream completes
 *
 * @param sdk - The Claude Agent SDK module
 *   (`import * as sdk from "@anthropic-ai/claude-agent-sdk"`).
 * @param options - Introspection configuration (token, serviceName, baseUrl, etc.).
 * @returns An {@link InstrumentedClaudeAgentSDK} with the same API plus
 *   `forceFlush()`, `shutdown()`, and `hooks`.
 *
 * @example
 * ```ts
 * import * as sdk from "@anthropic-ai/claude-agent-sdk";
 * import { withIntrospection } from "@introspection-sdk/introspection-node";
 *
 * const traced = withIntrospection(sdk, { serviceName: "my-agent" });
 * for await (const msg of traced.query({ prompt: "Hello" })) { /* … *\/ }
 * await traced.shutdown();
 * ```
 */
export function withIntrospection(
  sdk: ClaudeAgentSDKModule,
  options?: WithIntrospectionOptions,
): InstrumentedClaudeAgentSDK {
  const hooks = new IntrospectionClaudeHooks(options);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function wrappedQuery(params: any): any {
    // Auto-capture prompt
    if (typeof params?.prompt === "string") {
      hooks.setInputPrompt(params.prompt);
    }

    // Auto-capture systemPrompt from options
    const opts = (params?.options || {}) as Record<string, unknown>;
    if (typeof opts.systemPrompt === "string") {
      hooks.setSystemInstructions(opts.systemPrompt);
    }

    // Merge instrumentation hooks with any user-provided hooks
    const introspectionHooks = hooks.getHooks();
    const userHooks = opts.hooks as
      | Partial<Record<string, unknown[]>>
      | undefined;
    const mergedHooks = mergeHooks(introspectionHooks, userHooks);

    // Call original query with merged hooks
    const modifiedOptions = { ...opts, hooks: mergedHooks };
    const originalQuery = sdk.query({
      ...params,
      options: modifiedOptions,
    });

    // Wrap the async generator to intercept messages
    return wrapQueryResult(originalQuery, hooks);
  }

  return {
    ...sdk,
    query: wrappedQuery,
    hooks,
    forceFlush: () => hooks.forceFlush(),
    shutdown: () => hooks.shutdown(),
  };
}

/**
 * Merges introspection hooks with user-provided hooks.
 * Introspection hooks fire first, then user hooks.
 * User hooks on events we don't handle pass through untouched.
 */
function mergeHooks(
  introspectionHooks: ClaudeHooksConfig,
  userHooks?: Partial<Record<string, unknown[]>>,
): Record<string, unknown[]> {
  if (!userHooks) {
    return introspectionHooks as Record<string, unknown[]>;
  }

  const merged: Record<string, unknown[]> = {};
  const allEvents = new Set([
    ...Object.keys(introspectionHooks),
    ...Object.keys(userHooks),
  ]);

  for (const event of allEvents) {
    const ours = (introspectionHooks as Record<string, unknown[]>)[event] || [];
    const theirs = userHooks[event] || [];
    merged[event] = [...ours, ...theirs];
  }

  return merged;
}

/**
 * Wraps a Query async generator to intercept messages for usage recording.
 * Uses a Proxy to transparently forward all non-iterator properties
 * (interrupt, close, setModel, etc.) to the original Query object.
 */
function wrapQueryResult(
  originalQuery: unknown,
  hooks: IntrospectionClaudeHooks,
): unknown {
  const query = originalQuery as AsyncGenerator<ClaudeSDKMessage, void> &
    Record<string, unknown>;

  async function* instrumentedIterator(): AsyncGenerator<
    ClaudeSDKMessage,
    void
  > {
    try {
      for await (const message of query) {
        hooks.recordUsage(message);
        yield message;
      }
    } finally {
      try {
        await hooks.forceFlush();
      } catch (flushError) {
        logger.warn("Failed to flush spans after query completed", flushError);
      }
    }
  }

  const wrapped = instrumentedIterator();

  // Use Proxy to transparently delegate non-iterator properties to original query.
  // Iterator protocol methods come from our wrapper (bound to the actual generator
  // to avoid "incompatible receiver" errors); everything else (interrupt, close,
  // setModel, setPermissionMode, etc.) delegates to the original Query.
  return new Proxy(wrapped, {
    get(target, prop) {
      if (
        prop === Symbol.asyncIterator ||
        prop === "next" ||
        prop === "return" ||
        prop === "throw"
      ) {
        const value = Reflect.get(target, prop);
        if (typeof value === "function") {
          return value.bind(target);
        }
        return value;
      }
      const original = query[prop as string];
      if (typeof original === "function") {
        return original.bind(query);
      }
      return original;
    },
  });
}
