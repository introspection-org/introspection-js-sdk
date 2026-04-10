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
import { IntrospectionClaudeHooks, type IntrospectionClaudeHooksOptions } from "./claude-hooks.js";
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
export declare function withIntrospection(sdk: ClaudeAgentSDKModule, options?: WithIntrospectionOptions): InstrumentedClaudeAgentSDK;
//# sourceMappingURL=claude-wrapper.d.ts.map