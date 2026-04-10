/**
 * LangChain/LangGraph Callback Handler for Introspection.
 *
 * Hooks into LangChain's native callback system to capture LLM, tool, and
 * chain interactions as gen_ai.* OTel spans for the Introspection backend.
 *
 * Similar to IntrospectionTracingProcessor for OpenAI Agents SDK and
 * IntrospectionClaudeHooks for Claude Agent SDK.
 *
 * **Important:** This module requires `@langchain/core` at runtime.
 * Import via the subpath: `@introspection-sdk/introspection-node/langchain`
 *
 * @example
 * ```ts
 * import { IntrospectionCallbackHandler } from "@introspection-sdk/introspection-node/langchain";
 * import { ChatOpenAI } from "@langchain/openai";
 *
 * const handler = new IntrospectionCallbackHandler({
 *   serviceName: "my-langchain-app",
 * });
 *
 * const model = new ChatOpenAI({ modelName: "gpt-4o" });
 * const response = await model.invoke("Hello!", { callbacks: [handler] });
 *
 * await handler.shutdown();
 * ```
 */
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";
import type { BaseMessage } from "@langchain/core/messages";
import type { ChainValues } from "@langchain/core/utils/types";
import { type SpanExporter, type IdGenerator } from "@opentelemetry/sdk-trace-base";
/** Advanced options for testing and customization. */
export interface LangChainHandlerAdvancedOptions {
    /** Custom span exporter for testing. */
    spanExporter?: SpanExporter;
    /** Custom ID generator for testing. */
    idGenerator?: IdGenerator;
    /** Use SimpleSpanProcessor instead of BatchSpanProcessor. */
    useSimpleSpanProcessor?: boolean;
}
/** Configuration for {@link IntrospectionCallbackHandler}. */
export interface IntrospectionCallbackHandlerOptions {
    /** Authentication token (env: INTROSPECTION_TOKEN). */
    token?: string;
    /** Base URL for the API (env: INTROSPECTION_BASE_URL). */
    baseUrl?: string;
    /** Service name for telemetry (env: INTROSPECTION_SERVICE_NAME). */
    serviceName?: string;
    /** Additional headers to include in requests. */
    additionalHeaders?: Record<string, string>;
    /** Advanced options for testing. */
    advanced?: LangChainHandlerAdvancedOptions;
}
/**
 * LangChain callback handler that captures LLM, tool, and chain events
 * as gen_ai.* OTel spans and exports them to the Introspection backend.
 *
 * Pass as a callback to any LangChain invoke call, or set globally via
 * `setGlobalHandler()`.
 */
export declare class IntrospectionCallbackHandler extends BaseCallbackHandler {
    name: string;
    private _tracerProvider;
    private _tracer;
    private _spans;
    private _rootSpan;
    private _conversationId;
    private _spanNames;
    private _spanParents;
    private static _wrapperNames;
    private _llmInputs;
    constructor(options?: IntrospectionCallbackHandlerOptions);
    /** Get or create a root span so all callbacks share the same traceId. */
    private _ensureRoot;
    /** Create a child span under the root (or under a parent if provided).
     *  Sets gen_ai.agent.name to the parent span's name for hierarchy. */
    private _createChildSpan;
    handleChatModelStart(llm: Serialized, messages: BaseMessage[][], runId: string, parentRunId?: string, extraParams?: Record<string, unknown>, _tags?: string[], metadata?: Record<string, unknown>, runName?: string): void;
    handleLLMStart(llm: Serialized, prompts: string[], runId: string, parentRunId?: string, extraParams?: Record<string, unknown>, _tags?: string[], metadata?: Record<string, unknown>, runName?: string): void;
    handleLLMEnd(output: LLMResult, runId: string): void;
    handleLLMError(err: Error, runId: string): void;
    handleChainStart(chain: Serialized, _inputs: ChainValues, runId: string, _runType?: string, _tags?: string[], metadata?: Record<string, unknown>, runName?: string, parentRunId?: string): void;
    handleChainEnd(_outputs: ChainValues, runId: string): void;
    handleChainError(err: Error, runId: string): void;
    handleToolStart(tool: Serialized, input: string, runId: string, parentRunId?: string, _tags?: string[], _metadata?: Record<string, unknown>, runName?: string): void;
    handleToolEnd(output: unknown, runId: string): void;
    handleToolError(err: Error, runId: string): void;
    shutdown(): Promise<void>;
    forceFlush(): Promise<void>;
    private _extractModelName;
    private _extractProvider;
    /** Walk up the span tree to find the first non-wrapper span name. */
    private _findAgentName;
    private _getConversationId;
    private _convertMessages;
    private _mapRole;
    private _extractContent;
}
//# sourceMappingURL=langchain-handler.d.ts.map