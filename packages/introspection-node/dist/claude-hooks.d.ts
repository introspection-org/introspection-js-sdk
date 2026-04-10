/**
 * Claude Agent SDK Instrumentation Hooks
 *
 * Provides OpenTelemetry instrumentation for the Claude Agent SDK via its hooks system.
 * Creates spans for sessions, tool uses, and subagent executions with gen_ai.* attributes.
 *
 * @see https://platform.claude.com/docs/en/agent-sdk/typescript
 */
import { type SpanExporter, type IdGenerator } from "@opentelemetry/sdk-trace-base";
/** Common fields present on every hook input payload. */
export interface BaseHookInput {
    /** Active session identifier. */
    session_id: string;
    /** Path to the session transcript file. */
    transcript_path: string;
    /** Working directory of the agent process. */
    cwd: string;
    /** Permission mode the session is running in. */
    permission_mode?: string;
}
/** Input payload for the `SessionStart` hook. */
export interface SessionStartHookInput extends BaseHookInput {
    hook_event_name: "SessionStart";
    /** How the session was initiated. */
    source: "startup" | "resume" | "clear" | "compact";
    /** Agent type (e.g. `"main"`, `"subagent"`). */
    agent_type?: string;
    /** Model used for this session. */
    model?: string;
}
/** Input payload for the `SessionEnd` hook. */
export interface SessionEndHookInput extends BaseHookInput {
    hook_event_name: "SessionEnd";
    /** Reason the session ended. */
    reason: string;
}
/** Input payload for the `PreToolUse` hook. */
export interface PreToolUseHookInput extends BaseHookInput {
    hook_event_name: "PreToolUse";
    /** Name of the tool about to be invoked. */
    tool_name: string;
    /** Input data passed to the tool. */
    tool_input: unknown;
    /** Unique identifier for this tool invocation. */
    tool_use_id: string;
}
/** Input payload for the `PostToolUse` hook. */
export interface PostToolUseHookInput extends BaseHookInput {
    hook_event_name: "PostToolUse";
    /** Name of the tool that was invoked. */
    tool_name: string;
    /** Input data that was passed to the tool. */
    tool_input: unknown;
    /** Response returned by the tool. */
    tool_response: unknown;
    /** Unique identifier for this tool invocation. */
    tool_use_id: string;
}
/** Input payload for the `SubagentStart` hook. */
export interface SubagentStartHookInput extends BaseHookInput {
    hook_event_name: "SubagentStart";
    /** Identifier of the sub-agent. */
    agent_id: string;
    /** Type / name of the sub-agent. */
    agent_type: string;
}
/** Input payload for the `SubagentStop` hook. */
export interface SubagentStopHookInput extends BaseHookInput {
    hook_event_name: "SubagentStop";
    /** Identifier of the sub-agent. */
    agent_id: string;
    /** Type / name of the sub-agent. */
    agent_type: string;
    /** Path to the sub-agent's transcript. */
    agent_transcript_path: string;
}
/** Discriminated union of all possible hook input payloads. */
export type ClaudeHookInput = SessionStartHookInput | SessionEndHookInput | PreToolUseHookInput | PostToolUseHookInput | SubagentStartHookInput | SubagentStopHookInput;
/**
 * JSON-serialisable output returned by a hook callback
 * (`SyncHookJSONOutput` in the SDK).
 */
export type ClaudeHookOutput = {
    /** Whether the SDK should continue processing. */
    continue?: boolean;
    /** Suppress the default output for this hook event. */
    suppressOutput?: boolean;
    /** Reason to stop the session. */
    stopReason?: string;
    /** Approval decision for `PreToolUse` hooks. */
    decision?: "approve" | "block";
    /** System message to inject into the conversation. */
    systemMessage?: string;
    /** Human-readable reason for the decision. */
    reason?: string;
};
/**
 * Async callback signature for a Claude Agent SDK hook.
 *
 * @param input - The hook input payload.
 * @param toolUseID - The tool-use ID (set for `PreToolUse` / `PostToolUse`).
 * @param options - Abort signal for cancellation.
 * @returns A {@link ClaudeHookOutput} controlling the SDK's behaviour.
 */
export type ClaudeHookCallback = (input: ClaudeHookInput, toolUseID: string | undefined, options: {
    signal: AbortSignal;
}) => Promise<ClaudeHookOutput>;
/** Pairs an optional glob matcher with one or more hook callbacks. */
export interface ClaudeHookCallbackMatcher {
    /** Glob pattern to match tool names (only relevant for tool hooks). */
    matcher?: string;
    /** Callbacks to invoke when the matcher (or all events) match. */
    hooks: ClaudeHookCallback[];
    /** Timeout in milliseconds for hook execution. */
    timeout?: number;
}
/** String literal union of all Claude Agent SDK hook event names. */
export type ClaudeHookEvent = "PreToolUse" | "PostToolUse" | "SessionStart" | "SessionEnd" | "SubagentStart" | "SubagentStop";
/**
 * Full hooks configuration object accepted by the Claude Agent SDK
 * `query()` options. Maps each event name to an array of
 * {@link ClaudeHookCallbackMatcher} entries.
 */
export type ClaudeHooksConfig = Partial<Record<ClaudeHookEvent, ClaudeHookCallbackMatcher[]>>;
/** Token-level usage counters reported by the Claude API. */
export interface ClaudeUsage {
    /** Number of input tokens consumed. */
    input_tokens: number;
    /** Number of output tokens generated. */
    output_tokens: number;
    /** Tokens used to create new cache entries. */
    cache_creation_input_tokens?: number;
    /** Tokens read from cache. */
    cache_read_input_tokens?: number;
}
/** Per-model usage breakdown reported in a result message. */
export interface ClaudeModelUsage {
    /** Input tokens for this model. */
    inputTokens: number;
    /** Output tokens for this model. */
    outputTokens: number;
    /** Tokens read from cache for this model. */
    cacheReadInputTokens: number;
    /** Tokens used to create cache for this model. */
    cacheCreationInputTokens: number;
    /** Estimated cost in USD for this model. */
    costUSD: number;
}
/** A `"result"` message yielded at the end of a `query()` stream. */
export interface ClaudeResultMessage {
    type: "result";
    /** Aggregate token usage for the session. */
    usage?: ClaudeUsage;
    /** Total estimated cost in USD. */
    total_cost_usd?: number;
    /** Per-model usage breakdown. */
    modelUsage?: Record<string, ClaudeModelUsage>;
    /** Final text result (if any). */
    result?: string;
    /** Whether the session ended with an error. */
    is_error?: boolean;
    /** Session identifier. */
    session_id: string;
}
/** An `"assistant"` message yielded during a `query()` stream. */
export interface ClaudeAssistantMessage {
    type: "assistant";
    /** The underlying API message with optional usage and content. */
    message?: {
        id?: string;
        model?: string;
        usage?: {
            input_tokens?: number;
            output_tokens?: number;
        };
        content?: Array<{
            type: string;
            text?: string;
        }>;
    };
    /** Session identifier. */
    session_id: string;
}
/**
 * Discriminated union of all messages that can be yielded by a Claude Agent
 * SDK `query()` stream.
 */
export type ClaudeSDKMessage = ClaudeResultMessage | ClaudeAssistantMessage | {
    type: string;
    session_id?: string;
};
/** Advanced options for testing and customization of {@link IntrospectionClaudeHooks}. */
export interface ClaudeHooksAdvancedOptions {
    /** Custom span exporter (for testing) */
    spanExporter?: SpanExporter;
    /** Custom ID generator (for testing) */
    idGenerator?: IdGenerator;
    /** Use SimpleSpanProcessor instead of BatchSpanProcessor (for testing) */
    useSimpleSpanProcessor?: boolean;
}
/** Configuration for {@link IntrospectionClaudeHooks}. */
export interface IntrospectionClaudeHooksOptions {
    /** Authentication token (env: INTROSPECTION_TOKEN) */
    token?: string;
    /** Base URL for the API (env: INTROSPECTION_BASE_URL) */
    baseUrl?: string;
    /** Service name for the OTel resource (defaults to "claude-agent") */
    serviceName?: string;
    /** Agent name set on session spans as gen_ai.agent.name (defaults to serviceName) */
    agentName?: string;
    /** Additional headers to include in requests */
    additionalHeaders?: Record<string, string>;
    /** Advanced options for testing and customization */
    advanced?: ClaudeHooksAdvancedOptions;
}
/**
 * Provides instrumented hooks for Claude Agent SDK.
 *
 * Creates OpenTelemetry spans with gen_ai.* semantic convention attributes:
 * - Session spans: gen_ai.system, gen_ai.request.model
 * - Tool spans: gen_ai.tool.name, gen_ai.tool.input, gen_ai.tool.output
 * - Subagent spans: gen_ai.agent.name
 *
 * Usage tracking is captured from streamed messages via recordUsage().
 *
 * @example
 * ```typescript
 * import { query } from "@anthropic-ai/claude-agent-sdk";
 * import { IntrospectionClaudeHooks } from "@introspection-sdk/introspection-node";
 *
 * const hooks = new IntrospectionClaudeHooks();
 *
 * const stream = query({
 *   prompt: "Hello",
 *   options: {
 *     hooks: hooks.getHooks(),
 *   },
 * });
 *
 * for await (const message of stream) {
 *   hooks.recordUsage(message);
 *   // handle message...
 * }
 *
 * await hooks.shutdown();
 * ```
 */
export declare class IntrospectionClaudeHooks {
    private _tracerProvider;
    private _tracer;
    private _agentName;
    private _sessionSpans;
    private _toolSpans;
    private _subagentSpans;
    private _sessionUsage;
    constructor(options?: IntrospectionClaudeHooksOptions);
    /**
     * Build the hooks configuration object to pass to Claude Agent SDK
     * `query()` options.
     *
     * @returns A {@link ClaudeHooksConfig} wired to this instance's tracing.
     */
    getHooks(): ClaudeHooksConfig;
    /**
     * Set the input prompt for a session so it appears as
     * `gen_ai.input.messages` on the session span.
     *
     * If `sessionId` is not provided the prompt is buffered and associated
     * with the next session that starts via an `init` message.
     *
     * @param prompt - The user prompt string passed to `query()`.
     * @param sessionId - Optional session ID if already known.
     */
    setInputPrompt(prompt: string, sessionId?: string): void;
    private _pendingInputPrompt?;
    /**
     * Set system instructions for a session so they appear as
     * `gen_ai.system_instructions` on the session span.
     *
     * If `sessionId` is not provided the value is buffered and associated
     * with the next session that starts via an `init` message.
     *
     * @param instructions - The system prompt / instructions string.
     * @param sessionId - Optional session ID if already known.
     */
    setSystemInstructions(instructions: string, sessionId?: string): void;
    private _pendingSystemInstructions?;
    /**
     * Record usage from a streamed SDK message.
     *
     * Call this for **every** message yielded by `query()` to capture token
     * usage. Session spans are automatically created on `init` messages and
     * ended on `result` messages.
     *
     * @param message - A {@link ClaudeSDKMessage} yielded by the `query()` stream.
     */
    recordUsage(message: ClaudeSDKMessage): void;
    /**
     * Start a session span from an init system message.
     * This provides an alternative to the SessionStart hook which has timing issues.
     */
    private _startSessionFromMessage;
    /**
     * End a session span from a result message.
     * This provides an alternative to the SessionEnd hook which has timing issues.
     */
    private _endSessionFromMessage;
    private _onSessionStart;
    private _onSessionEnd;
    private _onPreToolUse;
    private _onPostToolUse;
    private _onSubagentStart;
    private _onSubagentStop;
    /**
     * Force-flush any buffered spans to the Introspection backend.
     *
     * @returns A promise that resolves once the flush completes.
     */
    forceFlush(): Promise<void>;
    /**
     * Shut down the hooks, ending any in-flight spans and flushing all
     * pending data.
     *
     * @returns A promise that resolves once shutdown is complete.
     */
    shutdown(): Promise<void>;
}
//# sourceMappingURL=claude-hooks.d.ts.map