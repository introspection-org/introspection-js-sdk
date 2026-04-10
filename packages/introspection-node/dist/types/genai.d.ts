/**
 * OTel Gen AI Semantic Convention types.
 *
 * These types represent the standardized format for gen_ai.input.messages
 * and gen_ai.output.messages attributes as per OpenTelemetry Gen AI semantic conventions.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/gen-ai/
 */
/**
 * A text content part in a message.
 *
 * @example
 * ```ts
 * const part: TextPart = { type: "text", content: "Hello" };
 * ```
 */
export interface TextPart {
    /** Discriminator — always `"text"`. */
    type: "text";
    /** The text body of this part. */
    content: string;
}
/**
 * A tool / function-call request part in a message.
 *
 * @example
 * ```ts
 * const part: ToolCallRequestPart = { type: "tool_call", name: "get_weather", arguments: { city: "SF" } };
 * ```
 */
export interface ToolCallRequestPart {
    /** Discriminator — always `"tool_call"`. */
    type: "tool_call";
    /** Function / tool name. */
    name: string;
    /** Correlation ID linking request to response. */
    id?: string;
    /** Arguments passed to the tool. */
    arguments?: unknown;
}
/**
 * A tool / function-call response part in a message.
 *
 * @example
 * ```ts
 * const part: ToolCallResponsePart = { type: "tool_call_response", response: "72°F" };
 * ```
 */
export interface ToolCallResponsePart {
    /** Discriminator — always `"tool_call_response"`. */
    type: "tool_call_response";
    /** The value returned by the tool. */
    response: unknown;
    /** Correlation ID linking response to request. */
    id?: string;
}
/**
 * A reasoning / thinking content part in a message.
 *
 * @example
 * ```ts
 * const part: ReasoningPart = { type: "thinking", content: "Let me think through this..." };
 * ```
 */
export interface ReasoningPart {
    /** Discriminator — always `"thinking"`. */
    type: "thinking";
    /** The reasoning / thinking summary content. */
    content?: string;
    /** Encrypted reasoning signature (maps to OpenAI encrypted_content, Anthropic signature/redacted_thinking data). */
    signature?: string;
    /** Provider that produced this thinking block (e.g. `"anthropic"`, `"openai"`). Used to reconstruct the correct wire format on replay. */
    provider_name?: string;
}
/** Union of all possible message-part shapes. */
export type MessagePart = TextPart | ToolCallRequestPart | ToolCallResponsePart | ReasoningPart;
/**
 * A system instruction entry for `gen_ai.system_instructions`.
 */
export interface SystemInstruction {
    /** Part type — always `"text"`. */
    type: "text";
    /** The instruction text content. */
    content: string;
}
/**
 * An input message in OTel Gen AI semantic convention format.
 *
 * Used for the `gen_ai.input.messages` span attribute.
 */
export interface InputMessage {
    /** The role of the message sender. */
    role: "system" | "user" | "assistant" | "tool";
    /** Ordered content parts that compose this message. */
    parts: MessagePart[];
    /** Optional tool name when `role` is `"tool"`. */
    name?: string;
}
/**
 * An output message in OTel Gen AI semantic convention format.
 *
 * Used for the `gen_ai.output.messages` span attribute.
 */
export interface OutputMessage {
    /** The role of the message sender. */
    role: "system" | "user" | "assistant" | "tool";
    /** Ordered content parts that compose this message. */
    parts: MessagePart[];
    /** Model-reported finish reason (e.g. `"stop"`, `"end_turn"`). */
    finish_reason?: string;
    /** Optional tool name when `role` is `"tool"`. */
    name?: string;
}
/**
 * A tool definition for the `gen_ai.tool.definitions` attribute.
 *
 * @example
 * ```ts
 * const def: ToolDefinition = { name: "get_weather", description: "Get current weather" };
 * ```
 */
export interface ToolDefinition {
    /** Tool / function name. */
    name: string;
    /** Human-readable description of what the tool does. */
    description?: string;
    /** JSON Schema describing the tool's parameters. */
    parameters?: Record<string, unknown>;
}
/**
 * GenAI semantic convention attributes.
 *
 * This interface represents the standardized GenAI attributes that can be
 * converted to OpenTelemetry semantic convention format (gen_ai.* with dots).
 *
 * All properties use camelCase following TypeScript conventions.
 */
export interface GenAiAttributes {
    /** Model name (gen_ai.request.model) */
    requestModel?: string;
    /** System prompt (gen_ai.system) */
    system?: string;
    /** Operation name (gen_ai.operation.name) */
    operationName?: string;
    /** Tool definitions (gen_ai.tool.definitions) — serialized to JSON by {@link toAttributes}. */
    toolDefinitions?: ToolDefinition[];
    /** Input messages (gen_ai.input.messages) — serialized to JSON by {@link toAttributes}. */
    inputMessages?: InputMessage[];
    /** Output messages (gen_ai.output.messages) — serialized to JSON by {@link toAttributes}. */
    outputMessages?: OutputMessage[];
    /** System instructions (gen_ai.system_instructions) — serialized to JSON by {@link toAttributes}. */
    systemInstructions?: SystemInstruction[];
    /** Response ID (gen_ai.response.id) */
    responseId?: string;
    /** Input token count (gen_ai.usage.input_tokens) */
    inputTokens?: number;
    /** Output token count (gen_ai.usage.output_tokens) */
    outputTokens?: number;
    /** Cache creation input tokens (gen_ai.usage.cache_creation_input_tokens) */
    cacheCreationInputTokens?: number;
    /** Cache read input tokens (gen_ai.usage.cache_read_input_tokens) */
    cacheReadInputTokens?: number;
}
export declare function toAttributes(attrs: GenAiAttributes): Record<string, string | number>;
//# sourceMappingURL=genai.d.ts.map