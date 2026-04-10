/**
 * Claude Agent SDK Instrumentation Hooks
 *
 * Provides OpenTelemetry instrumentation for the Claude Agent SDK via its hooks system.
 * Creates spans for sessions, tool uses, and subagent executions with gen_ai.* attributes.
 *
 * @see https://platform.claude.com/docs/en/agent-sdk/typescript
 */
import { context as otelContext, trace as otelTrace, SpanKind, SpanStatusCode, } from "@opentelemetry/api";
import { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes, defaultResource, } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { logger } from "./utils.js";
import { VERSION } from "./version.js";
import { convertClaudeSessionToOtelAttributes, } from "./converters/claude.js";
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
export class IntrospectionClaudeHooks {
    _tracerProvider;
    _tracer;
    _agentName;
    _sessionSpans = new Map();
    _toolSpans = new Map();
    _subagentSpans = new Map();
    _sessionUsage = new Map();
    constructor(options = {}) {
        const advanced = options.advanced;
        const serviceName = options.serviceName || "claude-agent";
        this._agentName = options.agentName || serviceName;
        const resource = defaultResource().merge(resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName }));
        if (!advanced?.spanExporter) {
            const token = options.token || process.env.INTROSPECTION_TOKEN;
            if (!token) {
                throw new Error("INTROSPECTION_TOKEN is required");
            }
            const baseUrl = options.baseUrl ||
                process.env.INTROSPECTION_BASE_URL ||
                "https://otel.introspection.dev";
            const headers = {
                "User-Agent": `introspection-sdk/${VERSION}`,
                Authorization: `Bearer ${token}`,
                ...options.additionalHeaders,
            };
            const endpoint = baseUrl.endsWith("/v1/traces")
                ? baseUrl
                : `${baseUrl.replace(/\/$/, "")}/v1/traces`;
            logger.info(`IntrospectionClaudeHooks initialized: service=${serviceName}, endpoint=${endpoint}`);
            const spanExporter = new OTLPTraceExporter({
                url: endpoint,
                headers,
            });
            // Default to sequential export for dev/staging tokens.
            const useSimple = advanced?.useSimpleSpanProcessor ||
                token.startsWith("intro_dev") ||
                token.startsWith("intro_staging");
            const spanProcessor = useSimple
                ? new SimpleSpanProcessor(spanExporter)
                : new BatchSpanProcessor(spanExporter, { scheduledDelayMillis: 1000 });
            this._tracerProvider = new BasicTracerProvider({
                resource,
                idGenerator: advanced?.idGenerator,
                spanProcessors: [spanProcessor],
            });
        }
        else {
            logger.info(`IntrospectionClaudeHooks initialized in test mode with custom exporter`);
            const spanProcessor = advanced.useSimpleSpanProcessor
                ? new SimpleSpanProcessor(advanced.spanExporter)
                : new BatchSpanProcessor(advanced.spanExporter, {
                    scheduledDelayMillis: 100,
                });
            this._tracerProvider = new BasicTracerProvider({
                resource,
                idGenerator: advanced.idGenerator,
                spanProcessors: [spanProcessor],
            });
        }
        this._tracer = this._tracerProvider.getTracer("claude-agent-sdk", VERSION);
    }
    /**
     * Build the hooks configuration object to pass to Claude Agent SDK
     * `query()` options.
     *
     * @returns A {@link ClaudeHooksConfig} wired to this instance's tracing.
     */
    getHooks() {
        return {
            SessionStart: [
                {
                    hooks: [this._onSessionStart.bind(this)],
                },
            ],
            SessionEnd: [
                {
                    hooks: [this._onSessionEnd.bind(this)],
                },
            ],
            PreToolUse: [
                {
                    hooks: [this._onPreToolUse.bind(this)],
                },
            ],
            PostToolUse: [
                {
                    hooks: [this._onPostToolUse.bind(this)],
                },
            ],
            SubagentStart: [
                {
                    hooks: [this._onSubagentStart.bind(this)],
                },
            ],
            SubagentStop: [
                {
                    hooks: [this._onSubagentStop.bind(this)],
                },
            ],
        };
    }
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
    setInputPrompt(prompt, sessionId) {
        if (sessionId) {
            const existing = this._sessionUsage.get(sessionId) || {
                input: 0,
                output: 0,
            };
            existing.inputPrompt = prompt;
            this._sessionUsage.set(sessionId, existing);
        }
        else {
            // Store for when session starts
            this._pendingInputPrompt = prompt;
        }
    }
    _pendingInputPrompt;
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
    setSystemInstructions(instructions, sessionId) {
        if (sessionId) {
            const existing = this._sessionUsage.get(sessionId) || {
                input: 0,
                output: 0,
            };
            existing.systemInstructions = instructions;
            this._sessionUsage.set(sessionId, existing);
        }
        else {
            this._pendingSystemInstructions = instructions;
        }
    }
    _pendingSystemInstructions;
    /**
     * Record usage from a streamed SDK message.
     *
     * Call this for **every** message yielded by `query()` to capture token
     * usage. Session spans are automatically created on `init` messages and
     * ended on `result` messages.
     *
     * @param message - A {@link ClaudeSDKMessage} yielded by the `query()` stream.
     */
    recordUsage(message) {
        const sessionId = message.session_id || "default";
        const msg = message;
        // Handle system init message - start session span
        if (message.type === "system" && msg.subtype === "init") {
            this._startSessionFromMessage(sessionId, msg);
            return;
        }
        if (message.type === "assistant") {
            const assistantMsg = message;
            const existing = this._sessionUsage.get(sessionId) || {
                input: 0,
                output: 0,
            };
            // Track usage
            const usage = assistantMsg.message?.usage;
            if (usage) {
                existing.input += usage.input_tokens || 0;
                existing.output += usage.output_tokens || 0;
                if (assistantMsg.message?.model) {
                    existing.model = assistantMsg.message.model;
                }
                logger.debug(`Recorded usage for session ${sessionId}: +${usage.input_tokens || 0} input, +${usage.output_tokens || 0} output`);
            }
            // Capture response ID from assistant message
            if (assistantMsg.message?.id) {
                existing.responseId = assistantMsg.message.id;
            }
            // Extract response content from assistant message
            const content = assistantMsg.message?.content;
            if (content && Array.isArray(content)) {
                // Store content blocks for proper conversion
                existing.responseBlocks = [
                    ...(existing.responseBlocks || []),
                    ...content,
                ];
                // Also extract text for backwards compatibility
                const textContent = content
                    .filter((block) => block.type === "text" && block.text)
                    .map((block) => block.text)
                    .join("");
                if (textContent) {
                    existing.responseContent =
                        (existing.responseContent || "") + textContent;
                }
            }
            this._sessionUsage.set(sessionId, existing);
        }
        else if (message.type === "result") {
            const resultMsg = message;
            const existing = this._sessionUsage.get(sessionId) || {
                input: 0,
                output: 0,
            };
            if (resultMsg.usage) {
                // Result message has final totals
                existing.input = resultMsg.usage.input_tokens || existing.input;
                existing.output = resultMsg.usage.output_tokens || existing.output;
            }
            if (resultMsg.total_cost_usd !== undefined) {
                existing.cost = resultMsg.total_cost_usd;
            }
            // Capture stop reason from result subtype
            const subtype = msg.subtype;
            if (subtype) {
                existing.stopReason = subtype;
            }
            this._sessionUsage.set(sessionId, existing);
            logger.debug(`Recorded final usage for session ${sessionId}: ${existing.input} input, ${existing.output} output, $${existing.cost || 0}`);
            // End session span on result message
            this._endSessionFromMessage(sessionId, msg);
        }
    }
    /**
     * Start a session span from an init system message.
     * This provides an alternative to the SessionStart hook which has timing issues.
     */
    _startSessionFromMessage(sessionId, msg) {
        // Don't create duplicate spans if hook already created one
        if (this._sessionSpans.has(sessionId)) {
            logger.debug(`Session span already exists for ${sessionId}, skipping`);
            return;
        }
        logger.debug(`Starting session span from init message: ${sessionId}`);
        const span = this._tracer.startSpan("claude.session", {
            kind: SpanKind.CLIENT,
            attributes: {
                "gen_ai.system": "anthropic",
                "gen_ai.operation.name": "chat",
                "gen_ai.agent.name": this._agentName,
                "claude.session_id": sessionId,
                "claude.source": "message",
            },
        });
        // Add model if present in init message
        const model = msg.model;
        if (model) {
            span.setAttribute("gen_ai.request.model", model);
        }
        // Add tools if present
        const tools = msg.tools;
        if (tools && tools.length > 0) {
            span.setAttribute("claude.tools", tools.join(","));
            span.setAttribute("gen_ai.tool.definitions", JSON.stringify(tools.map((name) => ({ name }))));
        }
        this._sessionSpans.set(sessionId, span);
        // Initialize session usage, including any pending input prompt and system instructions
        const sessionData = { input: 0, output: 0, model };
        if (tools && tools.length > 0) {
            sessionData.toolNames = tools;
        }
        if (this._pendingInputPrompt) {
            sessionData.inputPrompt = this._pendingInputPrompt;
            this._pendingInputPrompt = undefined;
        }
        if (this._pendingSystemInstructions) {
            sessionData.systemInstructions = this._pendingSystemInstructions;
            this._pendingSystemInstructions = undefined;
        }
        this._sessionUsage.set(sessionId, sessionData);
        logger.info(`Created session span for ${sessionId}`);
    }
    /**
     * End a session span from a result message.
     * This provides an alternative to the SessionEnd hook which has timing issues.
     */
    _endSessionFromMessage(sessionId, msg) {
        const span = this._sessionSpans.get(sessionId);
        if (!span) {
            logger.debug(`No session span found for ${sessionId}, nothing to end`);
            return;
        }
        const usage = this._sessionUsage.get(sessionId);
        // Use converter to set GenAI semantic convention attributes
        const otelAttrs = convertClaudeSessionToOtelAttributes({
            sessionId,
            inputPrompt: usage?.inputPrompt,
            responseContent: usage?.responseContent,
            responseBlocks: usage?.responseBlocks,
            model: usage?.model,
            inputTokens: usage?.input,
            outputTokens: usage?.output,
            costUsd: usage?.cost,
            stopReason: usage?.stopReason,
            responseId: usage?.responseId,
            toolNames: usage?.toolNames,
            systemInstructions: usage?.systemInstructions,
        });
        // Apply all converted attributes to the span
        for (const [key, value] of Object.entries(otelAttrs)) {
            span.setAttribute(key, value);
        }
        // Set subtype/reason from result message
        const subtype = msg.subtype;
        if (subtype) {
            span.setAttribute("claude.result_subtype", subtype);
            if (subtype === "success") {
                span.setStatus({ code: SpanStatusCode.OK });
            }
            else {
                span.setStatus({
                    code: SpanStatusCode.ERROR,
                    message: subtype,
                });
            }
        }
        else {
            span.setStatus({ code: SpanStatusCode.OK });
        }
        span.end();
        this._sessionSpans.delete(sessionId);
        this._sessionUsage.delete(sessionId);
        logger.info(`Ended session span for ${sessionId}: ${usage?.input || 0} input, ${usage?.output || 0} output tokens`);
    }
    async _onSessionStart(input, _toolUseID, _options) {
        void _toolUseID;
        void _options;
        const sessionInput = input;
        logger.debug(`SessionStart hook: ${sessionInput.session_id}`);
        const span = this._tracer.startSpan("claude.session", {
            kind: SpanKind.CLIENT,
            attributes: {
                "gen_ai.system": "anthropic",
                "gen_ai.operation.name": "chat",
                "gen_ai.agent.name": this._agentName,
                "claude.session_id": sessionInput.session_id,
                "claude.source": sessionInput.source,
            },
        });
        if (sessionInput.model) {
            span.setAttribute("gen_ai.request.model", sessionInput.model);
        }
        if (sessionInput.agent_type) {
            span.setAttribute("claude.agent_type", sessionInput.agent_type);
        }
        this._sessionSpans.set(sessionInput.session_id, span);
        // Initialize session usage, consuming any pending prompts/instructions
        const sessionUsage = {
            input: 0,
            output: 0,
        };
        if (this._pendingInputPrompt) {
            sessionUsage.inputPrompt = this._pendingInputPrompt;
            this._pendingInputPrompt = undefined;
        }
        if (this._pendingSystemInstructions) {
            sessionUsage.systemInstructions = this._pendingSystemInstructions;
            this._pendingSystemInstructions = undefined;
        }
        this._sessionUsage.set(sessionInput.session_id, sessionUsage);
        return { continue: true };
    }
    async _onSessionEnd(input, _toolUseID, _options) {
        void _toolUseID;
        void _options;
        const sessionInput = input;
        logger.debug(`SessionEnd hook: ${sessionInput.session_id}`);
        const span = this._sessionSpans.get(sessionInput.session_id);
        if (span) {
            const usage = this._sessionUsage.get(sessionInput.session_id);
            if (usage) {
                // Use converter for consistent gen_ai attribute mapping
                const otelAttrs = convertClaudeSessionToOtelAttributes({
                    sessionId: sessionInput.session_id,
                    inputPrompt: usage.inputPrompt,
                    responseContent: usage.responseContent,
                    responseBlocks: usage.responseBlocks,
                    model: usage.model,
                    inputTokens: usage.input,
                    outputTokens: usage.output,
                    costUsd: usage.cost,
                    stopReason: usage.stopReason,
                    responseId: usage.responseId,
                    toolNames: usage.toolNames,
                    systemInstructions: usage.systemInstructions,
                });
                for (const [key, value] of Object.entries(otelAttrs)) {
                    span.setAttribute(key, value);
                }
            }
            span.setAttribute("claude.exit_reason", sessionInput.reason);
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            this._sessionSpans.delete(sessionInput.session_id);
            this._sessionUsage.delete(sessionInput.session_id);
            logger.debug(`Ended session span for ${sessionInput.session_id}`);
        }
        return { continue: true };
    }
    async _onPreToolUse(input, _toolUseID, _options) {
        void _toolUseID;
        void _options;
        const toolInput = input;
        logger.debug(`PreToolUse: ${toolInput.tool_name} (${toolInput.tool_use_id})`);
        const parentSpan = this._sessionSpans.get(toolInput.session_id);
        const ctx = parentSpan
            ? otelTrace.setSpan(otelContext.active(), parentSpan)
            : undefined;
        const span = this._tracer.startSpan(`tool.${toolInput.tool_name}`, {
            kind: SpanKind.INTERNAL,
            attributes: {
                "gen_ai.tool.name": toolInput.tool_name,
                "claude.session_id": toolInput.session_id,
                "claude.tool_use_id": toolInput.tool_use_id,
            },
        }, ctx);
        if (toolInput.tool_input) {
            try {
                span.setAttribute("gen_ai.tool.input", JSON.stringify(toolInput.tool_input));
            }
            catch {
                span.setAttribute("gen_ai.tool.input", String(toolInput.tool_input));
            }
        }
        this._toolSpans.set(toolInput.tool_use_id, span);
        return { continue: true };
    }
    async _onPostToolUse(input, _toolUseID, _options) {
        void _toolUseID;
        void _options;
        const toolInput = input;
        logger.debug(`PostToolUse: ${toolInput.tool_name} (${toolInput.tool_use_id})`);
        const span = this._toolSpans.get(toolInput.tool_use_id);
        if (span) {
            if (toolInput.tool_response !== undefined) {
                try {
                    span.setAttribute("gen_ai.tool.output", JSON.stringify(toolInput.tool_response));
                }
                catch {
                    span.setAttribute("gen_ai.tool.output", String(toolInput.tool_response));
                }
            }
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            this._toolSpans.delete(toolInput.tool_use_id);
        }
        return { continue: true };
    }
    async _onSubagentStart(input, _toolUseID, _options) {
        void _toolUseID;
        void _options;
        const subagentInput = input;
        logger.debug(`SubagentStart: ${subagentInput.agent_type} (${subagentInput.agent_id})`);
        const parentSpan = this._sessionSpans.get(subagentInput.session_id);
        const ctx = parentSpan
            ? otelTrace.setSpan(otelContext.active(), parentSpan)
            : undefined;
        const span = this._tracer.startSpan(`subagent.${subagentInput.agent_type}`, {
            kind: SpanKind.INTERNAL,
            attributes: {
                "gen_ai.agent.name": subagentInput.agent_type,
                "claude.session_id": subagentInput.session_id,
                "claude.agent_id": subagentInput.agent_id,
            },
        }, ctx);
        this._subagentSpans.set(subagentInput.agent_id, span);
        return { continue: true };
    }
    async _onSubagentStop(input, _toolUseID, _options) {
        void _toolUseID;
        void _options;
        const subagentInput = input;
        logger.debug(`SubagentStop: ${subagentInput.agent_type} (${subagentInput.agent_id})`);
        const span = this._subagentSpans.get(subagentInput.agent_id);
        if (span) {
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            this._subagentSpans.delete(subagentInput.agent_id);
        }
        return { continue: true };
    }
    /**
     * Force-flush any buffered spans to the Introspection backend.
     *
     * @returns A promise that resolves once the flush completes.
     */
    async forceFlush() {
        await this._tracerProvider.forceFlush();
    }
    /**
     * Shut down the hooks, ending any in-flight spans and flushing all
     * pending data.
     *
     * @returns A promise that resolves once shutdown is complete.
     */
    async shutdown() {
        // End any remaining spans
        for (const [, span] of this._sessionSpans) {
            span.end();
        }
        for (const [, span] of this._toolSpans) {
            span.end();
        }
        for (const [, span] of this._subagentSpans) {
            span.end();
        }
        this._sessionSpans.clear();
        this._toolSpans.clear();
        this._subagentSpans.clear();
        this._sessionUsage.clear();
        await this._tracerProvider.shutdown();
    }
}
