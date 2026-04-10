/**
 * OTel Gen AI Semantic Convention types.
 *
 * These types represent the standardized format for gen_ai.input.messages
 * and gen_ai.output.messages attributes as per OpenTelemetry Gen AI semantic conventions.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */
/**
 * Convert a {@link GenAiAttributes} object to an OTel-compatible attributes
 * dictionary with `gen_ai.*` dot-notation keys.
 *
 * Properties that are `undefined` are omitted from the result.
 *
 * @param attrs - The camelCase {@link GenAiAttributes} to convert.
 * @returns A flat `Record<string, string | number>` with OTel semconv keys.
 *
 * @example
 * ```ts
 * const otel = toAttributes({ requestModel: "gpt-4", inputTokens: 42 });
 * // { "gen_ai.request.model": "gpt-4", "gen_ai.usage.input_tokens": 42 }
 * ```
 */
/**
 * Recursively strip `undefined` and `null` values from an object before
 * JSON serialization.  Equivalent to Python's `model_dump(exclude_none=True)`.
 */
function stripNullish(obj) {
    if (Array.isArray(obj))
        return obj.map(stripNullish);
    if (obj !== null && typeof obj === "object") {
        const out = {};
        for (const [key, value] of Object.entries(obj)) {
            if (value !== undefined && value !== null) {
                out[key] = stripNullish(value);
            }
        }
        return out;
    }
    return obj;
}
export function toAttributes(attrs) {
    const result = {};
    if (attrs.requestModel !== undefined) {
        result["gen_ai.request.model"] = attrs.requestModel;
    }
    if (attrs.system !== undefined) {
        result["gen_ai.system"] = attrs.system;
    }
    if (attrs.operationName !== undefined) {
        result["gen_ai.operation.name"] = attrs.operationName;
    }
    if (attrs.toolDefinitions !== undefined) {
        result["gen_ai.tool.definitions"] = JSON.stringify(stripNullish(attrs.toolDefinitions));
    }
    if (attrs.inputMessages !== undefined) {
        result["gen_ai.input.messages"] = JSON.stringify(stripNullish(attrs.inputMessages));
    }
    if (attrs.outputMessages !== undefined) {
        result["gen_ai.output.messages"] = JSON.stringify(stripNullish(attrs.outputMessages));
    }
    if (attrs.systemInstructions !== undefined) {
        result["gen_ai.system_instructions"] = JSON.stringify(stripNullish(attrs.systemInstructions));
    }
    if (attrs.responseId !== undefined) {
        result["gen_ai.response.id"] = attrs.responseId;
    }
    if (attrs.inputTokens !== undefined) {
        result["gen_ai.usage.input_tokens"] = attrs.inputTokens;
    }
    if (attrs.outputTokens !== undefined) {
        result["gen_ai.usage.output_tokens"] = attrs.outputTokens;
    }
    if (attrs.cacheCreationInputTokens !== undefined) {
        result["gen_ai.usage.cache_creation.input_tokens"] =
            attrs.cacheCreationInputTokens;
    }
    if (attrs.cacheReadInputTokens !== undefined) {
        result["gen_ai.usage.cache_read.input_tokens"] = attrs.cacheReadInputTokens;
    }
    return result;
}
