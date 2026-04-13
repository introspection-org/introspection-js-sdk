/**
 * First-party Pi Agent SDK instrumentation for Introspection.
 *
 * Provides two functions that wrap a Pi agent session to produce OTel
 * GenAI spans for model calls and tool executions:
 *
 *   instrumentPiModelCalls(agent, tracer, meta, getParentContext)
 *   instrumentPiToolExecutions(session, tracer, meta, getParentContext)
 *
 * Uses structural typing — no @mariozechner/* imports required.
 *
 * @example
 * ```typescript
 * import { instrumentPiModelCalls, instrumentPiToolExecutions } from "@introspection-sdk/introspection-node/pi";
 *
 * const unsubModel = instrumentPiModelCalls(session.agent, tracer, meta, () => turnContext);
 * const unsubTool = instrumentPiToolExecutions(session, tracer, meta, () => turnContext);
 * ```
 */
import { type Context as OTelContext, type Tracer } from "@opentelemetry/api";
export { piMessagesToSemconv, piAssistantToSemconv, piSystemPromptToSemconv, semconvToPiMessages, } from "./converters/pi-agent.js";
export interface PiInstrumentationMeta {
    conversationId: string;
    agentId: string;
    agentName: string;
    systemPrompt?: string;
    toolDefinitions?: Array<{
        name: string;
        description?: string;
        parameters?: unknown;
    }>;
}
interface PiModel {
    provider: string;
    id: string;
}
interface PiContext {
    messages: unknown[];
    systemPrompt?: string;
    tools?: PiTool[];
}
interface PiTool {
    name: string;
    description?: string;
    parameters?: unknown;
}
interface PiAssistantMessage {
    usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
    };
    stopReason: string;
    errorMessage?: string;
    responseId?: string;
    id?: string;
}
interface PiAssistantMessageEvent {
    type: string;
    message?: PiAssistantMessage;
    error?: PiAssistantMessage;
    messageId?: string;
}
/** Async iterable of Pi events with a push/end interface. */
interface PiEventStream {
    push(event: PiAssistantMessageEvent): void;
    end(): void;
    [Symbol.asyncIterator](): AsyncIterator<PiAssistantMessageEvent>;
}
type PiStreamFn = (model: PiModel, context: PiContext, options?: unknown) => PiEventStream | Promise<PiEventStream>;
/** Structural type for the Pi agent object. */
export interface PiAgentLike {
    streamFn: PiStreamFn;
}
/** Structural type for the Pi session object. */
export interface PiSessionLike {
    subscribe(callback: (event: Record<string, unknown>) => void): () => void;
}
/**
 * Instrument a Pi agent's model calls with OTel GenAI spans.
 *
 * Wraps `agent.streamFn` to intercept every LLM call, creating a span
 * with input/output messages, token usage, tool definitions, and system
 * instructions.
 *
 * @returns A function that restores the original `streamFn`.
 */
export declare function instrumentPiModelCalls(agent: PiAgentLike, tracer: Tracer, meta: PiInstrumentationMeta, getParentContext?: () => OTelContext | null | undefined, flushFn?: () => void): () => void;
/**
 * Instrument a Pi session's tool executions with OTel spans.
 *
 * Subscribes to `tool_execution_start` and `tool_execution_end` events,
 * creating a span for each tool invocation with arguments and results.
 *
 * @returns A function that unsubscribes and ends any active tool spans.
 */
export declare function instrumentPiToolExecutions(session: PiSessionLike, tracer: Tracer, meta: PiInstrumentationMeta, getParentContext?: () => OTelContext | null | undefined, flushFn?: () => void): () => void;
//# sourceMappingURL=pi-instrumentation.d.ts.map