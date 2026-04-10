/**
 * Lightweight Anthropic instrumentor for Introspection SDK.
 *
 * Captures the full Anthropic response including thinking blocks (extended
 * thinking) with signatures, which third-party instrumentors drop.
 *
 * Supports both non-streaming (`messages.create`) and streaming
 * (`messages.create({ stream: true })`) calls.
 *
 * @example
 * ```ts
 * import { AnthropicInstrumentor } from "@introspection-sdk/introspection-node";
 *
 * const instrumentor = new AnthropicInstrumentor();
 * instrumentor.instrument({ tracerProvider: provider });
 * // All client.messages.create calls are now traced
 * ```
 */
import type { Tracer } from "@opentelemetry/api";
import type { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
/** Sentinel value for redacted thinking blocks — content was encrypted by safety systems. */
export declare const REDACTED_THINKING_CONTENT = "[redacted]";
/**
 * Traced wrapper around `client.messages.create(kwargs)`.
 * Creates a gen_ai span with full Anthropic response including thinking blocks.
 */
export declare function tracedMessagesCreate(tracer: Tracer, client: {
    messages: {
        create: (...args: unknown[]) => Promise<unknown>;
    };
}, kwargs: Record<string, unknown>): Promise<unknown>;
/**
 * Auto-instrumentor that patches `Anthropic.messages.create` to add tracing.
 *
 * Captures all content blocks including thinking (extended thinking) with
 * signatures. Supports both non-streaming and streaming calls.
 */
/**
 * Auto-instrumentor that wraps an Anthropic client instance to add tracing.
 *
 * Captures all content blocks including thinking (extended thinking) with
 * signatures. Supports both non-streaming and streaming calls.
 */
export declare class AnthropicInstrumentor {
    private tracer;
    private patchedClients;
    instrument(opts: {
        tracerProvider?: BasicTracerProvider;
        /** The Anthropic client instance to instrument. */
        client: any;
    }): void;
    uninstrument(): void;
}
//# sourceMappingURL=anthropic.d.ts.map