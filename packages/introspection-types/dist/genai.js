/**
 * OTel Gen AI Semantic Convention types.
 *
 * Standardized JSON shapes for the `gen_ai.input.messages`,
 * `gen_ai.output.messages`, `gen_ai.system_instructions`, and
 * `gen_ai.tool.definitions` span attributes.
 *
 * Used by all `@introspection-sdk/*` packages that emit GenAI spans:
 * `introspection-node`, `introspection-openclaw`, `introspection-pi-agent`.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */
const ATTRIBUTE_NAMES = {
    requestModel: "gen_ai.request.model",
    providerName: "gen_ai.provider.name",
    system: "gen_ai.system",
    operationName: "gen_ai.operation.name",
    toolDefinitions: "gen_ai.tool.definitions",
    inputMessages: "gen_ai.input.messages",
    outputMessages: "gen_ai.output.messages",
    systemInstructions: "gen_ai.system_instructions",
    responseId: "gen_ai.response.id",
    responseModel: "gen_ai.response.model",
    finishReasons: "gen_ai.response.finish_reasons",
    inputTokens: "gen_ai.usage.input_tokens",
    outputTokens: "gen_ai.usage.output_tokens",
    cacheCreationInputTokens: "gen_ai.usage.cache_creation.input_tokens",
    cacheReadInputTokens: "gen_ai.usage.cache_read.input_tokens",
    costUsd: "gen_ai.cost.usd",
};
/**
 * Convert a {@link GenAiAttributes} object into an OTel-compatible
 * `Record<string, string | number>` with `gen_ai.*` dotted keys.
 *
 * Properties that are `undefined` are omitted. Object-valued properties
 * (`toolDefinitions`, `inputMessages`, …) are JSON-serialized with `null`
 * and `undefined` stripped.
 */
export function toAttributes(attrs) {
    const result = {};
    for (const key of Object.keys(attrs)) {
        const value = attrs[key];
        if (value === undefined)
            continue;
        const otelKey = ATTRIBUTE_NAMES[key];
        if (typeof value === "string" || typeof value === "number") {
            result[otelKey] = value;
        }
        else {
            result[otelKey] = JSON.stringify(stripNullish(value));
        }
    }
    return result;
}
/**
 * Recursively strip `undefined` and `null` values from an object before
 * JSON serialization. Equivalent to Python's `model_dump(exclude_none=True)`.
 */
function stripNullish(value) {
    if (Array.isArray(value))
        return value.map(stripNullish);
    if (value !== null && typeof value === "object") {
        const out = {};
        for (const [key, entry] of Object.entries(value)) {
            if (entry !== undefined && entry !== null) {
                out[key] = stripNullish(entry);
            }
        }
        return out;
    }
    return value;
}
/**
 * GenAI semantic-convention attribute names.
 *
 * Useful when setting attributes on a span directly (`span.setAttributes`)
 * without going through {@link toAttributes}.
 */
export const GenAi = {
    CONVERSATION_ID: "gen_ai.conversation.id",
    AGENT_ID: "gen_ai.agent.id",
    AGENT_NAME: "gen_ai.agent.name",
    OPERATION_NAME: "gen_ai.operation.name",
    PROVIDER_NAME: "gen_ai.provider.name",
    REQUEST_MODEL: "gen_ai.request.model",
    RESPONSE_MODEL: "gen_ai.response.model",
    RESPONSE_ID: "gen_ai.response.id",
    RESPONSE_FINISH_REASONS: "gen_ai.response.finish_reasons",
    USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
    USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
    USAGE_CACHE_READ_INPUT_TOKENS: "gen_ai.usage.cache_read.input_tokens",
    USAGE_CACHE_CREATION_INPUT_TOKENS: "gen_ai.usage.cache_creation.input_tokens",
    COST_USD: "gen_ai.cost.usd",
    INPUT_MESSAGES: "gen_ai.input.messages",
    OUTPUT_MESSAGES: "gen_ai.output.messages",
    SYSTEM_INSTRUCTIONS: "gen_ai.system_instructions",
    TOOL_DEFINITIONS: "gen_ai.tool.definitions",
    TOOL_NAME: "gen_ai.tool.name",
    TOOL_TYPE: "gen_ai.tool.type",
    TOOL_CALL_ID: "gen_ai.tool.call.id",
    TOOL_CALL_ARGUMENTS: "gen_ai.tool.call.arguments",
    TOOL_CALL_RESULT: "gen_ai.tool.call.result",
};
/** Default span name builders for chat / execute_tool / invoke_agent. */
export const GenAiSpanName = {
    chat: (provider) => `chat ${provider}`,
    executeTool: (toolName) => `execute_tool ${toolName}`,
    invokeAgent: (agentName) => `invoke_agent ${agentName}`,
};
