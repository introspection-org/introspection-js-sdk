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
import { context as otelContext, trace as otelTrace, } from "@opentelemetry/api";
import { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor, } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { randomUUID } from "crypto";
import { logger } from "./utils.js";
import { VERSION } from "./version.js";
// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
/**
 * LangChain callback handler that captures LLM, tool, and chain events
 * as gen_ai.* OTel spans and exports them to the Introspection backend.
 *
 * Pass as a callback to any LangChain invoke call, or set globally via
 * `setGlobalHandler()`.
 */
export class IntrospectionCallbackHandler extends BaseCallbackHandler {
    name = "IntrospectionCallbackHandler";
    _tracerProvider;
    _tracer;
    _spans = new Map();
    _rootSpan = null;
    _conversationId;
    // Track span names and parents so children can resolve gen_ai.agent.name
    _spanNames = new Map();
    _spanParents = new Map();
    // LangChain wrapper names to skip when resolving agent names
    static _wrapperNames = new Set([
        "RunnableSequence",
        "RunnableParallel",
        "RunnableMap",
        "RunnableLambda",
        "RunnableRetry",
        "_ConfigurableModel",
        "ChatOpenAI",
        "ChatAnthropic",
        "ChatGoogleGenerativeAI",
        "ChatGroq",
    ]);
    // Store LLM input messages per runId for use in handleLLMEnd
    _llmInputs = new Map();
    constructor(options = {}) {
        super();
        const advanced = options.advanced;
        const serviceName = options.serviceName || process.env.INTROSPECTION_SERVICE_NAME;
        const resource = serviceName
            ? resourceFromAttributes({ [ATTR_SERVICE_NAME]: serviceName })
            : undefined;
        if (!advanced?.spanExporter) {
            const token = options.token || process.env.INTROSPECTION_TOKEN;
            if (!token) {
                throw new Error("INTROSPECTION_TOKEN is required");
            }
            const baseUrl = options.baseUrl ||
                process.env.INTROSPECTION_BASE_URL ||
                "https://otel.introspection.dev";
            const endpoint = baseUrl.endsWith("/v1/traces")
                ? baseUrl
                : `${baseUrl.replace(/\/$/, "")}/v1/traces`;
            const headers = {
                "User-Agent": `introspection-sdk/${VERSION}`,
                Authorization: `Bearer ${token}`,
                ...options.additionalHeaders,
            };
            logger.info(`IntrospectionCallbackHandler initialized: endpoint=${endpoint}`);
            const spanExporter = new OTLPTraceExporter({ url: endpoint, headers });
            const effectiveBatchSize = token.startsWith("intro_dev") || token.startsWith("intro_staging")
                ? 1
                : undefined;
            const useSimple = advanced?.useSimpleSpanProcessor || effectiveBatchSize === 1;
            const spanProcessor = useSimple
                ? new SimpleSpanProcessor(spanExporter)
                : new BatchSpanProcessor(spanExporter, {
                    scheduledDelayMillis: 1000,
                    ...(effectiveBatchSize
                        ? { maxExportBatchSize: effectiveBatchSize }
                        : {}),
                });
            this._tracerProvider = new BasicTracerProvider({
                resource,
                idGenerator: advanced?.idGenerator,
                spanProcessors: [spanProcessor],
            });
        }
        else {
            logger.info("IntrospectionCallbackHandler initialized in test mode with custom exporter");
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
        this._tracer = this._tracerProvider.getTracer("langchain", VERSION);
        this._conversationId = `intro_conv_${randomUUID().replace(/-/g, "")}`;
    }
    /** Get or create a root span so all callbacks share the same traceId. */
    _ensureRoot() {
        if (!this._rootSpan) {
            this._rootSpan = this._tracer.startSpan("langchain-run");
            this._rootSpan.setAttribute("gen_ai.conversation.id", this._conversationId);
        }
        return this._rootSpan;
    }
    /** Create a child span under the root (or under a parent if provided).
     *  Sets gen_ai.agent.name to the parent span's name for hierarchy. */
    _createChildSpan(name, runId, parentRunId) {
        const parent = (parentRunId ? this._spans.get(parentRunId) : undefined) ||
            this._ensureRoot();
        const ctx = otelTrace.setSpan(otelContext.active(), parent);
        const span = this._tracer.startSpan(name, {}, ctx);
        this._spanNames.set(runId, name);
        if (parentRunId) {
            this._spanParents.set(runId, parentRunId);
        }
        // Walk up parents to find first non-wrapper name for gen_ai.agent.name
        const agentName = this._findAgentName(parentRunId);
        if (agentName) {
            span.setAttribute("gen_ai.agent.name", agentName);
        }
        return span;
    }
    // -------------------------------------------------------------------------
    // Chat model callbacks (preferred over LLM callbacks for chat models)
    // -------------------------------------------------------------------------
    handleChatModelStart(llm, messages, runId, parentRunId, extraParams, _tags, metadata, runName) {
        const modelName = this._extractModelName(llm, extraParams);
        const spanName = modelName ? `chat ${modelName}` : runName || "chat";
        const otelSpan = this._createChildSpan(spanName, runId, parentRunId);
        this._spans.set(runId, otelSpan);
        const conversationId = this._getConversationId(metadata);
        otelSpan.setAttribute("gen_ai.operation.name", "chat");
        otelSpan.setAttribute("gen_ai.conversation.id", conversationId);
        otelSpan.setAttribute("openinference.span.kind", "LLM");
        if (modelName) {
            otelSpan.setAttribute("gen_ai.request.model", modelName);
        }
        const flatMessages = messages[0] || [];
        const { inputMessages, systemInstructions } = this._convertMessages(flatMessages);
        if (inputMessages.length > 0) {
            otelSpan.setAttribute("gen_ai.input.messages", JSON.stringify(inputMessages));
            this._llmInputs.set(runId, inputMessages);
        }
        if (systemInstructions.length > 0) {
            otelSpan.setAttribute("gen_ai.system_instructions", JSON.stringify(systemInstructions.map((s) => ({ type: "text", content: s }))));
        }
        const provider = this._extractProvider(llm);
        if (provider) {
            otelSpan.setAttribute("gen_ai.system", provider);
        }
        const invocationParams = extraParams?.["invocation_params"];
        const tools = invocationParams?.["tools"];
        if (tools && tools.length > 0) {
            otelSpan.setAttribute("gen_ai.tool.definitions", JSON.stringify(tools.map((t) => {
                const fn = (t.function || t);
                return {
                    type: t.type || "function",
                    name: (fn.name || ""),
                    description: (fn.description || ""),
                    parameters: fn.parameters,
                };
            })));
        }
        if (invocationParams?.["temperature"] != null) {
            otelSpan.setAttribute("gen_ai.request.temperature", invocationParams["temperature"]);
        }
    }
    handleLLMStart(llm, prompts, runId, parentRunId, extraParams, _tags, metadata, runName) {
        const modelName = this._extractModelName(llm, extraParams);
        const spanName = modelName ? `chat ${modelName}` : runName || "llm";
        const otelSpan = this._createChildSpan(spanName, runId, parentRunId);
        this._spans.set(runId, otelSpan);
        const conversationId = this._getConversationId(metadata);
        otelSpan.setAttribute("gen_ai.operation.name", "chat");
        otelSpan.setAttribute("gen_ai.conversation.id", conversationId);
        otelSpan.setAttribute("openinference.span.kind", "LLM");
        if (modelName) {
            otelSpan.setAttribute("gen_ai.request.model", modelName);
        }
        if (prompts.length > 0) {
            const inputMessages = prompts.map((p) => ({
                role: "user",
                parts: [{ type: "text", content: p }],
            }));
            otelSpan.setAttribute("gen_ai.input.messages", JSON.stringify(inputMessages));
            this._llmInputs.set(runId, inputMessages);
        }
    }
    handleLLMEnd(output, runId) {
        const otelSpan = this._spans.get(runId);
        if (!otelSpan)
            return;
        this._spans.delete(runId);
        this._spanNames.delete(runId);
        this._llmInputs.delete(runId);
        const generations = output.generations?.[0];
        if (generations && generations.length > 0) {
            const parts = [];
            for (const gen of generations) {
                if (gen.text) {
                    parts.push({ type: "text", content: gen.text });
                }
                const msg = gen.message;
                const kwargs = (msg?.["kwargs"] || msg);
                const additionalKwargs = kwargs?.["additional_kwargs"];
                const toolCalls = (additionalKwargs?.["tool_calls"] ||
                    kwargs?.["tool_calls"]);
                if (toolCalls) {
                    for (const tc of toolCalls) {
                        const fn = (tc.function || tc);
                        parts.push({
                            type: "tool_call",
                            name: (fn.name || tc.name || ""),
                            id: (tc.id || ""),
                            arguments: (fn.arguments || tc.args || ""),
                        });
                    }
                }
            }
            if (parts.length > 0) {
                const outputMessages = [{ role: "assistant", parts }];
                otelSpan.setAttribute("gen_ai.output.messages", JSON.stringify(outputMessages));
            }
        }
        const usage = output.llmOutput;
        const tokenUsage = (usage?.["tokenUsage"] ||
            usage?.["token_usage"] ||
            usage?.["usage"]);
        if (tokenUsage) {
            const inputTokens = tokenUsage["promptTokens"] ||
                tokenUsage["prompt_tokens"] ||
                tokenUsage["input_tokens"];
            const outputTokens = tokenUsage["completionTokens"] ||
                tokenUsage["completion_tokens"] ||
                tokenUsage["output_tokens"];
            if (typeof inputTokens === "number") {
                otelSpan.setAttribute("gen_ai.usage.input_tokens", inputTokens);
            }
            if (typeof outputTokens === "number") {
                otelSpan.setAttribute("gen_ai.usage.output_tokens", outputTokens);
            }
        }
        const model = usage?.["model"] || usage?.["model_name"];
        if (typeof model === "string") {
            otelSpan.setAttribute("gen_ai.response.model", model);
        }
        // gen_ai.response.id — required by the server for conversation tracking.
        const responseId = usage?.["id"] || usage?.["system_fingerprint"];
        otelSpan.setAttribute("gen_ai.response.id", typeof responseId === "string" ? responseId : `langchain-${runId}`);
        otelSpan.end();
    }
    handleLLMError(err, runId) {
        const otelSpan = this._spans.get(runId);
        if (!otelSpan)
            return;
        this._spans.delete(runId);
        this._spanNames.delete(runId);
        this._llmInputs.delete(runId);
        otelSpan.setAttribute("error", true);
        otelSpan.setAttribute("error.message", err.message);
        otelSpan.end();
    }
    // -------------------------------------------------------------------------
    // Chain callbacks
    // -------------------------------------------------------------------------
    handleChainStart(chain, _inputs, runId, _runType, _tags, metadata, runName, parentRunId) {
        const name = runName || chain?.name || chain?.id?.[chain.id.length - 1] || "chain";
        const otelSpan = this._createChildSpan(name, runId, parentRunId);
        this._spans.set(runId, otelSpan);
        const conversationId = this._getConversationId(metadata);
        otelSpan.setAttribute("gen_ai.conversation.id", conversationId);
    }
    handleChainEnd(_outputs, runId) {
        const otelSpan = this._spans.get(runId);
        if (!otelSpan)
            return;
        this._spans.delete(runId);
        otelSpan.end();
    }
    handleChainError(err, runId) {
        const otelSpan = this._spans.get(runId);
        if (!otelSpan)
            return;
        this._spans.delete(runId);
        otelSpan.setAttribute("error", true);
        otelSpan.setAttribute("error.message", err.message);
        otelSpan.end();
    }
    // -------------------------------------------------------------------------
    // Tool callbacks
    // -------------------------------------------------------------------------
    handleToolStart(tool, input, runId, parentRunId, _tags, _metadata, runName) {
        const toolName = runName || tool?.name || tool?.id?.[tool.id.length - 1] || "tool";
        const otelSpan = this._createChildSpan(toolName, runId, parentRunId);
        this._spans.set(runId, otelSpan);
        otelSpan.setAttribute("gen_ai.tool.name", toolName);
        otelSpan.setAttribute("openinference.span.kind", "TOOL");
        otelSpan.setAttribute("gen_ai.tool.input", input);
        otelSpan.setAttribute("gen_ai.conversation.id", this._conversationId);
    }
    handleToolEnd(output, runId) {
        const otelSpan = this._spans.get(runId);
        if (!otelSpan)
            return;
        this._spans.delete(runId);
        if (output != null) {
            otelSpan.setAttribute("gen_ai.tool.output", typeof output === "string" ? output : JSON.stringify(output));
        }
        otelSpan.end();
    }
    handleToolError(err, runId) {
        const otelSpan = this._spans.get(runId);
        if (!otelSpan)
            return;
        this._spans.delete(runId);
        otelSpan.setAttribute("error", true);
        otelSpan.setAttribute("error.message", err.message);
        otelSpan.end();
    }
    // -------------------------------------------------------------------------
    // Lifecycle
    // -------------------------------------------------------------------------
    async shutdown() {
        for (const span of this._spans.values())
            span.end();
        this._spans.clear();
        if (this._rootSpan) {
            this._rootSpan.end();
            this._rootSpan = null;
        }
        await this._tracerProvider.shutdown();
    }
    async forceFlush() {
        await this._tracerProvider.forceFlush();
    }
    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------
    _extractModelName(llm, extraParams) {
        const invocationParams = extraParams?.["invocation_params"];
        if (invocationParams) {
            const model = invocationParams["model"] ||
                invocationParams["model_name"] ||
                invocationParams["modelName"];
            if (typeof model === "string")
                return model;
        }
        const kwargs = llm?.kwargs;
        if (kwargs) {
            const model = kwargs["model"] || kwargs["model_name"] || kwargs["modelName"];
            if (typeof model === "string")
                return model;
        }
        return undefined;
    }
    _extractProvider(llm) {
        const id = llm?.id;
        if (Array.isArray(id) && id.length > 0) {
            return id[id.length - 1];
        }
        return undefined;
    }
    /** Walk up the span tree to find the first non-wrapper span name. */
    _findAgentName(runId) {
        let current = runId;
        for (let i = 0; i < 20 && current; i++) {
            const name = this._spanNames.get(current);
            if (name && !IntrospectionCallbackHandler._wrapperNames.has(name)) {
                return name;
            }
            current = this._spanParents.get(current);
        }
        return undefined;
    }
    _getConversationId(metadata) {
        const metaConvId = metadata?.["gen_ai.conversation.id"];
        return metaConvId || this._conversationId;
    }
    _convertMessages(messages) {
        const inputMessages = [];
        const systemInstructions = [];
        for (const msg of messages) {
            const msgType = msg._getType?.() ||
                msg.type ||
                "unknown";
            const role = this._mapRole(msgType);
            const content = this._extractContent(msg.content);
            if (role === "system") {
                systemInstructions.push(typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content));
                continue;
            }
            const parts = [];
            if (role === "tool") {
                const toolCallId = msg
                    .tool_call_id || "";
                parts.push({
                    type: "tool_call_response",
                    id: toolCallId,
                    response: content,
                });
            }
            else if (content) {
                parts.push({ type: "text", content });
            }
            const toolCalls = msg
                .tool_calls;
            if (toolCalls) {
                for (const tc of toolCalls) {
                    parts.push({
                        type: "tool_call",
                        name: (tc.name || ""),
                        id: (tc.id || ""),
                        arguments: typeof tc.args === "string" ? tc.args : JSON.stringify(tc.args),
                    });
                }
            }
            if (parts.length > 0) {
                inputMessages.push({ role, parts });
            }
        }
        return { inputMessages, systemInstructions };
    }
    _mapRole(msgType) {
        switch (msgType) {
            case "human":
                return "user";
            case "ai":
                return "assistant";
            case "system":
                return "system";
            case "tool":
                return "tool";
            default:
                return "user";
        }
    }
    _extractContent(content) {
        if (typeof content === "string")
            return content;
        if (Array.isArray(content)) {
            return content
                .map((part) => {
                const p = part;
                if (p.type === "text")
                    return (p.text || "");
                return "";
            })
                .filter(Boolean)
                .join("");
        }
        return String(content || "");
    }
}
