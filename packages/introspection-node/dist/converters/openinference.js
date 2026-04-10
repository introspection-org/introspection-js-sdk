import { toAttributes } from "../types/genai.js";
const OI = {
    MODEL_NAME: "llm.model_name",
    SYSTEM: "llm.system",
    INVOCATION_PARAMETERS: "llm.invocation_parameters",
    TOKEN_COUNT_PROMPT: "llm.token_count.prompt",
    TOKEN_COUNT_COMPLETION: "llm.token_count.completion",
    TOKEN_COUNT_TOTAL: "llm.token_count.total",
    INPUT_MESSAGES: "llm.input_messages",
    OUTPUT_MESSAGES: "llm.output_messages",
    TOOLS: "llm.tools",
    TOOL_NAME: "tool.name",
    TOOL_DESCRIPTION: "tool.description",
    TOOL_PARAMETERS: "tool.parameters",
    TOOL_JSON_SCHEMA: "tool.json_schema",
    OUTPUT_VALUE: "output.value",
    OUTPUT_MIME_TYPE: "output.mime_type",
};
/**
 * Check whether an OTel scope name belongs to an OpenInference instrumentor.
 *
 * @param scopeName - The `instrumentationScope.name` from a {@link ReadableSpan}.
 * @returns `true` when the scope starts with `"openinference"` or `"@arizeai/openinference"`.
 *
 * @example
 * ```ts
 * if (isOpenInferenceSpan(span.instrumentationScope.name)) {
 *   // convert attributes …
 * }
 * ```
 */
export function isOpenInferenceSpan(scopeName) {
    if (!scopeName)
        return false;
    return (scopeName.startsWith("openinference") ||
        scopeName.startsWith("@arizeai/openinference"));
}
function extractModel(attrs) {
    return attrs[OI.MODEL_NAME];
}
function extractSystem(attrs) {
    return attrs[OI.SYSTEM];
}
function extractTokenCounts(attrs) {
    return {
        input: attrs[OI.TOKEN_COUNT_PROMPT],
        output: attrs[OI.TOKEN_COUNT_COMPLETION],
        cacheCreation: attrs["llm.token_count.prompt_details.cache_write"],
        cacheRead: attrs["llm.token_count.prompt_details.cache_read"],
    };
}
/** Safely traverse nested object path */
function getPath(obj, ...keys) {
    let current = obj;
    for (const key of keys) {
        if (typeof current !== "object" || current === null)
            return undefined;
        current = current[key];
    }
    return current;
}
/**
 * Extract response ID from LangChain's nested output structure.
 * Path: generations[*][*].message.kwargs.id
 */
function extractLangChainResponseId(payload) {
    const generations = getPath(payload, "generations");
    if (!Array.isArray(generations))
        return undefined;
    for (const outer of generations) {
        const items = Array.isArray(outer) ? outer : [outer];
        for (const item of items) {
            const id = getPath(item, "message", "kwargs", "id");
            if (typeof id === "string" && id)
                return id;
        }
    }
    return undefined;
}
function extractResponseId(attrs) {
    const existing = attrs["gen_ai.response.id"];
    if (typeof existing === "string" && existing)
        return existing;
    const outputValue = attrs[OI.OUTPUT_VALUE];
    if (typeof outputValue !== "string")
        return undefined;
    try {
        const parsed = JSON.parse(outputValue);
        return parsed?.id ?? extractLangChainResponseId(parsed);
    }
    catch {
        return undefined;
    }
}
function extractSystemInstructions(attrs) {
    const inputValue = attrs["input.value"];
    if (!inputValue)
        return undefined;
    try {
        const parsed = JSON.parse(inputValue);
        if (!parsed?.system)
            return undefined;
        // Plain string system prompt
        if (typeof parsed.system === "string") {
            return [{ type: "text", content: parsed.system }];
        }
        // Array of content blocks (e.g. Anthropic API with cache_control)
        if (Array.isArray(parsed.system)) {
            const instructions = [];
            for (const block of parsed.system) {
                if (block?.type === "text" && typeof block.text === "string") {
                    instructions.push({ type: "text", content: block.text });
                }
            }
            return instructions.length > 0 ? instructions : undefined;
        }
    }
    catch {
        // ignore parse errors
    }
    return undefined;
}
function extractToolDefinitions(attrs) {
    const tools = [];
    for (const [key, value] of Object.entries(attrs)) {
        const match = key.match(/^llm\.tools\.(\d+)\.tool\.json_schema$/);
        if (!match || !value)
            continue;
        try {
            const raw = typeof value === "string" ? JSON.parse(value) : value;
            // LangChain format: {"type":"function","function":{name, description, parameters}}
            // Standard format: {title/name, description, parameters}
            const schema = raw?.type === "function" && raw?.function ? raw.function : raw;
            tools.push({
                type: "function",
                name: schema?.name ?? schema?.title ?? `tool_${match[1]}`,
                description: schema?.description,
                parameters: schema?.parameters ?? schema,
            });
        }
        catch {
            // Skip malformed JSON
        }
    }
    return tools.length > 0 ? tools : undefined;
}
function extractInputMessages(attrs) {
    const messages = [];
    const indices = new Set();
    for (const key of Object.keys(attrs)) {
        const match = key.match(/^llm\.input_messages\.(\d+)\./);
        if (match && match[1]) {
            indices.add(parseInt(match[1], 10));
        }
    }
    for (const idx of Array.from(indices).sort((a, b) => a - b)) {
        const role = attrs[`llm.input_messages.${idx}.message.role`];
        const content = attrs[`llm.input_messages.${idx}.message.content`];
        if (role) {
            const parts = [];
            if (content) {
                parts.push({ type: "text", content });
            }
            else {
                // Structured content (e.g. Vercel AI SDK): llm.input_messages.{i}.message.contents.{j}.message_content.text
                const contentIndices = new Set();
                for (const key of Object.keys(attrs)) {
                    const m = key.match(new RegExp(`^llm\\.input_messages\\.${idx}\\.message\\.contents\\.(\\d+)\\.`));
                    if (m && m[1])
                        contentIndices.add(parseInt(m[1], 10));
                }
                for (const cIdx of Array.from(contentIndices).sort((a, b) => a - b)) {
                    const prefix = `llm.input_messages.${idx}.message.contents.${cIdx}`;
                    const type = attrs[`${prefix}.message_content.type`];
                    const text = attrs[`${prefix}.message_content.text`];
                    if (text) {
                        parts.push({
                            type: type === "text" ? "text" : "text",
                            content: text,
                        });
                    }
                }
            }
            messages.push({ role: role, parts });
        }
    }
    // Drop trailing assistant messages — these are prefills (e.g. `{`) injected
    // by the app to coerce JSON output, not real conversation turns.
    while (messages.length > 0 &&
        messages[messages.length - 1].role === "assistant") {
        messages.pop();
    }
    return messages.length > 0 ? messages : undefined;
}
function extractOutputMessages(attrs) {
    const messages = [];
    const indices = new Set();
    for (const key of Object.keys(attrs)) {
        const match = key.match(/^llm\.output_messages\.(\d+)\./);
        if (match && match[1]) {
            indices.add(parseInt(match[1], 10));
        }
    }
    for (const idx of Array.from(indices).sort((a, b) => a - b)) {
        const role = attrs[`llm.output_messages.${idx}.message.role`];
        const content = attrs[`llm.output_messages.${idx}.message.content`];
        if (role) {
            const parts = [];
            if (content) {
                parts.push({ type: "text", content });
            }
            else {
                // Structured content (e.g. Anthropic OI instrumentor): llm.output_messages.{i}.message.contents.{j}.message_content.text
                const contentIndices = new Set();
                for (const key of Object.keys(attrs)) {
                    const m = key.match(new RegExp(`^llm\\.output_messages\\.${idx}\\.message\\.contents\\.(\\d+)\\.`));
                    if (m && m[1])
                        contentIndices.add(parseInt(m[1], 10));
                }
                for (const cIdx of Array.from(contentIndices).sort((a, b) => a - b)) {
                    const prefix = `llm.output_messages.${idx}.message.contents.${cIdx}`;
                    const rawText = attrs[`${prefix}.message_content.text`] ??
                        attrs[`${prefix}.message.content.text`];
                    if (rawText) {
                        parts.push({ type: "text", content: rawText });
                    }
                }
            }
            const toolCallIndices = new Set();
            for (const key of Object.keys(attrs)) {
                const match = key.match(new RegExp(`^llm\\.output_messages\\.${idx}\\.message\\.tool_calls\\.(\\d+)\\.`));
                if (match && match[1]) {
                    toolCallIndices.add(parseInt(match[1], 10));
                }
            }
            for (const tcIdx of Array.from(toolCallIndices).sort((a, b) => a - b)) {
                const prefix = `llm.output_messages.${idx}.message.tool_calls.${tcIdx}.tool_call`;
                const toolName = attrs[`${prefix}.function.name`];
                const toolArgs = attrs[`${prefix}.function.arguments`];
                const toolId = attrs[`${prefix}.id`];
                if (toolName === "submit_response" && toolArgs) {
                    // Extract thinking and response from submit_response tool call
                    try {
                        const parsed = JSON.parse(toolArgs);
                        if (typeof parsed.thinking === "string" && parsed.thinking) {
                            const reasoningPart = {
                                type: "thinking",
                                content: parsed.thinking,
                            };
                            parts.push(reasoningPart);
                        }
                        if (typeof parsed.response === "string" && parsed.response) {
                            parts.push({ type: "text", content: parsed.response });
                        }
                    }
                    catch {
                        // Fall back to raw tool_call if JSON parse fails
                        parts.push({
                            type: "tool_call",
                            name: toolName,
                            arguments: toolArgs,
                            id: toolId,
                        });
                    }
                }
                else if (toolName) {
                    parts.push({
                        type: "tool_call",
                        name: toolName,
                        arguments: toolArgs,
                        id: toolId,
                    });
                }
            }
            messages.push({ role: role, parts });
        }
    }
    // Fallback: if no llm.output_messages.* found, construct from output.value
    if (messages.length === 0) {
        const outputValue = attrs[OI.OUTPUT_VALUE];
        if (typeof outputValue === "string" && outputValue) {
            messages.push({
                role: "assistant",
                parts: [{ type: "text", content: outputValue }],
            });
        }
    }
    return messages.length > 0 ? messages : undefined;
}
/**
 * Convert OpenInference span attributes to camelCase {@link GenAiAttributes}.
 *
 * Extracts `llm.*`, `tool.*`, and `output.*` keys and maps them to the
 * corresponding Gen AI semantic convention fields.
 *
 * @param attrs - Raw OTel {@link Attributes} from an OpenInference span.
 * @returns A {@link GenAiAttributes} object with all recognised fields populated.
 *
 * @example
 * ```ts
 * const genAi = convertOpenInferenceToGenAI(span.attributes);
 * console.log(genAi.requestModel); // e.g. "gpt-4"
 * ```
 */
export function convertOpenInferenceToGenAI(attrs) {
    if (!attrs)
        return {};
    const result = {};
    const model = extractModel(attrs);
    if (model)
        result.requestModel = model;
    const system = extractSystem(attrs);
    if (system)
        result.system = system;
    const responseId = extractResponseId(attrs);
    if (responseId)
        result.responseId = responseId;
    const tokens = extractTokenCounts(attrs);
    if (tokens.input !== undefined)
        result.inputTokens = tokens.input;
    if (tokens.output !== undefined)
        result.outputTokens = tokens.output;
    if (tokens.cacheCreation !== undefined)
        result.cacheCreationInputTokens = tokens.cacheCreation;
    if (tokens.cacheRead !== undefined)
        result.cacheReadInputTokens = tokens.cacheRead;
    const sysInstr = extractSystemInstructions(attrs);
    if (sysInstr)
        result.systemInstructions = sysInstr;
    const toolDefs = extractToolDefinitions(attrs);
    if (toolDefs)
        result.toolDefinitions = toolDefs;
    const inputMsgs = extractInputMessages(attrs);
    if (inputMsgs)
        result.inputMessages = inputMsgs;
    const outputMsgs = extractOutputMessages(attrs);
    if (outputMsgs)
        result.outputMessages = outputMsgs;
    // Default operation name to "chat" for LLM spans so the frontend can display them
    const spanKind = attrs["openinference.span.kind"];
    if (spanKind === "LLM" && !attrs["gen_ai.operation.name"]) {
        result.operationName = "chat";
    }
    return result;
}
/**
 * Replace all OpenInference `llm.*` / `tool.*` / `output.*` attributes with
 * their `gen_ai.*` equivalents, preserving every other attribute unchanged.
 *
 * @param attrs - Raw OTel {@link Attributes} that may contain OpenInference keys.
 * @returns A new {@link Attributes} dictionary with OpenInference keys replaced.
 *
 * @example
 * ```ts
 * const converted = replaceOpenInferenceWithGenAI(span.attributes);
 * // converted["gen_ai.request.model"] is set; "llm.model_name" is removed
 * ```
 */
export function replaceOpenInferenceWithGenAI(attrs) {
    if (!attrs)
        return {};
    const genaiAttrs = convertOpenInferenceToGenAI(attrs);
    const result = {};
    for (const [key, value] of Object.entries(attrs)) {
        if (!key.startsWith("llm.") &&
            !key.startsWith("tool.") &&
            !key.startsWith("output.")) {
            result[key] = value;
        }
    }
    const genaiOtelAttrs = toAttributes(genaiAttrs);
    for (const [key, value] of Object.entries(genaiOtelAttrs)) {
        result[key] = value;
    }
    return result;
}
// ---------------------------------------------------------------------------
// GenAI → OpenInference (reverse direction)
// ---------------------------------------------------------------------------
function flattenGenAIMessages(attrs, srcKey, prefix) {
    const raw = attrs[srcKey];
    if (!raw || typeof raw !== "string")
        return;
    try {
        const messages = JSON.parse(raw);
        if (!Array.isArray(messages))
            return;
        messages.forEach((msg, i) => {
            if (msg.role) {
                attrs[`${prefix}.${i}.message.role`] = msg.role;
            }
            if (Array.isArray(msg.parts)) {
                const textParts = msg.parts.filter((p) => p.type === "text");
                if (textParts.length > 0) {
                    attrs[`${prefix}.${i}.message.content`] = textParts
                        .map((p) => p.content)
                        .join("\n");
                }
                const toolCalls = msg.parts.filter((p) => p.type === "tool_call");
                toolCalls.forEach((tc, j) => {
                    attrs[`${prefix}.${i}.message.tool_calls.${j}.tool_call.function.name`] = tc.name;
                    attrs[`${prefix}.${i}.message.tool_calls.${j}.tool_call.function.arguments`] =
                        typeof tc.arguments === "string"
                            ? tc.arguments
                            : JSON.stringify(tc.arguments);
                    if (tc.id) {
                        attrs[`${prefix}.${i}.message.tool_calls.${j}.tool_call.id`] =
                            tc.id;
                    }
                });
            }
            if (typeof msg.content === "string") {
                attrs[`${prefix}.${i}.message.content`] = msg.content;
            }
        });
    }
    catch {
        // ignore parse errors
    }
}
/**
 * Enrich a {@link ReadableSpan} with OpenInference attributes derived from its
 * `gen_ai.*` attributes.
 *
 * Use this when exporting Mastra traces to Arize / Phoenix, which expects
 * OpenInference conventions (`openinference.span.kind`, `llm.model_name`,
 * flattened `llm.input_messages.N.message.role`, token counts, etc.).
 *
 * @param span - The OTel {@link ReadableSpan} to enrich.
 * @returns A shallow copy of the span with additional OpenInference attributes.
 *
 * @example
 * ```ts
 * const enriched = addOpenInferenceAttributes(span);
 * exporter.export([enriched], cb);
 * ```
 */
export function addOpenInferenceAttributes(span) {
    const attrs = { ...span.attributes };
    const spanType = attrs["mastra.span.type"];
    switch (spanType) {
        case "MODEL_GENERATION":
            attrs["openinference.span.kind"] = "LLM";
            break;
        case "AGENT_RUN":
            attrs["openinference.span.kind"] = "CHAIN";
            break;
        case "TOOL_CALL":
        case "MCP_TOOL_CALL":
            attrs["openinference.span.kind"] = "TOOL";
            break;
    }
    if (attrs["gen_ai.request.model"]) {
        attrs[OI.MODEL_NAME] = attrs["gen_ai.request.model"];
    }
    if (attrs["gen_ai.provider.name"]) {
        attrs["llm.provider"] = attrs["gen_ai.provider.name"];
    }
    const inputTokens = attrs["gen_ai.usage.input_tokens"];
    const outputTokens = attrs["gen_ai.usage.output_tokens"];
    if (inputTokens !== undefined) {
        attrs[OI.TOKEN_COUNT_PROMPT] = inputTokens;
    }
    if (outputTokens !== undefined) {
        attrs[OI.TOKEN_COUNT_COMPLETION] = outputTokens;
    }
    if (inputTokens !== undefined && outputTokens !== undefined) {
        attrs[OI.TOKEN_COUNT_TOTAL] = inputTokens + outputTokens;
    }
    const params = {};
    if (attrs["gen_ai.request.temperature"] !== undefined)
        params.temperature = attrs["gen_ai.request.temperature"];
    if (attrs["gen_ai.request.max_tokens"] !== undefined)
        params.max_tokens = attrs["gen_ai.request.max_tokens"];
    if (attrs["gen_ai.request.top_p"] !== undefined)
        params.top_p = attrs["gen_ai.request.top_p"];
    if (Object.keys(params).length > 0) {
        attrs[OI.INVOCATION_PARAMETERS] = JSON.stringify(params);
    }
    flattenGenAIMessages(attrs, "gen_ai.input.messages", OI.INPUT_MESSAGES);
    flattenGenAIMessages(attrs, "gen_ai.output.messages", OI.OUTPUT_MESSAGES);
    if (attrs["mastra.agent_run.input"]) {
        attrs["input.value"] = attrs["mastra.agent_run.input"];
    }
    if (attrs["mastra.agent_run.output"]) {
        attrs[OI.OUTPUT_VALUE] = attrs["mastra.agent_run.output"];
    }
    if (attrs["gen_ai.tool.name"]) {
        attrs[OI.TOOL_NAME] = attrs["gen_ai.tool.name"];
    }
    if (attrs["gen_ai.tool.description"]) {
        attrs[OI.TOOL_DESCRIPTION] = attrs["gen_ai.tool.description"];
    }
    if (attrs["gen_ai.tool.call.arguments"]) {
        attrs["input.value"] = attrs["gen_ai.tool.call.arguments"];
    }
    if (attrs["gen_ai.tool.call.result"]) {
        attrs[OI.OUTPUT_VALUE] = attrs["gen_ai.tool.call.result"];
    }
    return {
        ...span,
        attributes: attrs,
        spanContext: span.spanContext,
    };
}
/**
 * {@link SpanExporter} wrapper that enriches every span with OpenInference
 * attributes before forwarding it to the inner exporter.
 *
 * Use this when exporting Mastra / `gen_ai` traces to Arize or Phoenix.
 *
 * @example
 * ```ts
 * const otlp = new OTLPTraceExporter({ url: "https://otlp.arize.com/v1/traces" });
 * const exporter = new OpenInferenceSpanExporter(otlp);
 * provider.addSpanProcessor(new BatchSpanProcessor(exporter));
 * ```
 */
export class OpenInferenceSpanExporter {
    inner;
    /**
     * @param inner - The downstream {@link SpanExporter} to forward enriched spans to.
     */
    constructor(inner) {
        this.inner = inner;
    }
    /**
     * Enrich each span with OpenInference attributes, then forward the batch.
     *
     * @param spans - Completed spans to export.
     * @param resultCallback - Callback invoked with the export result code.
     */
    export(spans, resultCallback) {
        this.inner.export(spans.map(addOpenInferenceAttributes), resultCallback);
    }
    /**
     * Shut down the inner exporter.
     *
     * @returns A promise that resolves when the inner exporter has shut down.
     */
    async shutdown() {
        return this.inner.shutdown();
    }
    /**
     * Flush any buffered spans in the inner exporter.
     *
     * @returns A promise that resolves when the flush completes.
     */
    async forceFlush() {
        return this.inner.forceFlush?.();
    }
}
