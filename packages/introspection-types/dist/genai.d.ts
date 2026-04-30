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
/**
 * A text content part in a message.
 *
 * `text_signature` carries opaque per-block signatures used by some
 * providers (e.g. OpenAI Responses message metadata) so a replayed
 * conversation can be sent back to the same provider without losing
 * signed continuity.
 */
export interface TextPart {
    /** Discriminator — always `"text"`. */
    type: "text";
    /** The text body of this part. */
    content: string;
    /** Optional opaque per-block signature for replay continuity. */
    text_signature?: string;
}
/**
 * A reasoning / thinking content part in a message.
 *
 * `signature` carries the encrypted reasoning payload (Anthropic
 * `signature` / `redacted_thinking`, OpenAI `encrypted_content`).
 * `redacted` is set when the upstream provider redacted the visible
 * content but kept the signed payload.
 */
export interface ReasoningPart {
    /** Discriminator — always `"thinking"`. */
    type: "thinking";
    /** The reasoning / thinking summary content. */
    content?: string;
    /** Encrypted reasoning signature (Anthropic signature / redacted_thinking, OpenAI encrypted_content). */
    signature?: string;
    /** Provider that produced this thinking block (e.g. `"anthropic"`, `"openai"`). Used to reconstruct the correct wire format on replay. */
    provider_name?: string;
    /** True when the thinking content was redacted by safety filters but the signed payload is preserved. */
    redacted?: boolean;
}
/** A tool / function-call request part in a message. */
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
/** A tool / function-call response part in a message. */
export interface ToolCallResponsePart {
    /** Discriminator — always `"tool_call_response"`. */
    type: "tool_call_response";
    /** The value returned by the tool. */
    response: unknown;
    /** Correlation ID linking response to request. */
    id?: string;
    /** Optional tool name. Stored on `tool` messages whose tool_call counterpart was lost. */
    name?: string;
}
/** Union of all possible message-part shapes. */
export type MessagePart = TextPart | ReasoningPart | ToolCallRequestPart | ToolCallResponsePart;
/** A system instruction entry for `gen_ai.system_instructions`. */
export interface SystemInstruction {
    /** Part type — always `"text"`. */
    type: "text";
    /** The instruction text content. */
    content: string;
}
/** Roles allowed on input/output messages. */
export type MessageRole = "system" | "user" | "assistant" | "tool";
/**
 * An input message (`gen_ai.input.messages` element).
 */
export interface InputMessage {
    role: MessageRole;
    parts: MessagePart[];
    /** Optional tool name when `role` is `"tool"`. */
    name?: string;
}
/**
 * An output message (`gen_ai.output.messages` element).
 */
export interface OutputMessage {
    role: MessageRole;
    parts: MessagePart[];
    /** Model-reported finish reason (e.g. `"stop"`, `"length"`, `"tool_use"`). */
    finish_reason?: string;
    /** Optional tool name when `role` is `"tool"`. */
    name?: string;
    /** Provider name as reported by the model — useful when output messages are replayed across providers. */
    provider?: string;
    /** Concrete model id used for the response. */
    model?: string;
    /** API surface used to produce this response (e.g. `"openai-responses"`). */
    api?: string;
    /** Provider-specific response identifier when the upstream API exposes one. */
    response_id?: string;
}
/** A tool definition for the `gen_ai.tool.definitions` attribute. */
export interface ToolDefinition {
    /** Tool / function name. */
    name: string;
    /** Human-readable description of what the tool does. */
    description?: string;
    /** JSON Schema describing the tool's parameters. */
    parameters?: unknown;
}
/**
 * Camel-cased GenAI attribute bag, convenient for callers that don't want to
 * deal with OTel's dotted attribute names directly.
 *
 * {@link toAttributes} converts this to a flat `Record<string, string | number>`
 * with `gen_ai.*` keys.
 */
export interface GenAiAttributes {
    /** Model name (gen_ai.request.model) */
    requestModel?: string;
    /** Provider name (gen_ai.provider.name) */
    providerName?: string;
    /**
     * Legacy provider name (gen_ai.system).
     * @deprecated Prefer {@link GenAiAttributes.providerName} (`gen_ai.provider.name`).
     */
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
    /** Response model (gen_ai.response.model) */
    responseModel?: string;
    /** Finish reason array (gen_ai.response.finish_reasons) — serialized to JSON. */
    finishReasons?: string[];
    /** Input token count (gen_ai.usage.input_tokens) */
    inputTokens?: number;
    /** Output token count (gen_ai.usage.output_tokens) */
    outputTokens?: number;
    /** Cache creation input tokens (gen_ai.usage.cache_creation.input_tokens) */
    cacheCreationInputTokens?: number;
    /** Cache read input tokens (gen_ai.usage.cache_read.input_tokens) */
    cacheReadInputTokens?: number;
    /** Cost in USD (gen_ai.cost.usd) */
    costUsd?: number;
}
/**
 * Convert a {@link GenAiAttributes} object into an OTel-compatible
 * `Record<string, string | number>` with `gen_ai.*` dotted keys.
 *
 * Properties that are `undefined` are omitted. Object-valued properties
 * (`toolDefinitions`, `inputMessages`, …) are JSON-serialized with `null`
 * and `undefined` stripped.
 */
export declare function toAttributes(attrs: GenAiAttributes): Record<string, string | number>;
/**
 * GenAI semantic-convention attribute names.
 *
 * Useful when setting attributes on a span directly (`span.setAttributes`)
 * without going through {@link toAttributes}.
 */
export declare const GenAi: {
    readonly CONVERSATION_ID: "gen_ai.conversation.id";
    readonly AGENT_ID: "gen_ai.agent.id";
    readonly AGENT_NAME: "gen_ai.agent.name";
    readonly OPERATION_NAME: "gen_ai.operation.name";
    readonly PROVIDER_NAME: "gen_ai.provider.name";
    readonly REQUEST_MODEL: "gen_ai.request.model";
    readonly RESPONSE_MODEL: "gen_ai.response.model";
    readonly RESPONSE_ID: "gen_ai.response.id";
    readonly RESPONSE_FINISH_REASONS: "gen_ai.response.finish_reasons";
    readonly USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens";
    readonly USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens";
    readonly USAGE_CACHE_READ_INPUT_TOKENS: "gen_ai.usage.cache_read.input_tokens";
    readonly USAGE_CACHE_CREATION_INPUT_TOKENS: "gen_ai.usage.cache_creation.input_tokens";
    readonly COST_USD: "gen_ai.cost.usd";
    readonly INPUT_MESSAGES: "gen_ai.input.messages";
    readonly OUTPUT_MESSAGES: "gen_ai.output.messages";
    readonly SYSTEM_INSTRUCTIONS: "gen_ai.system_instructions";
    readonly TOOL_DEFINITIONS: "gen_ai.tool.definitions";
    readonly TOOL_NAME: "gen_ai.tool.name";
    readonly TOOL_TYPE: "gen_ai.tool.type";
    readonly TOOL_CALL_ID: "gen_ai.tool.call.id";
    readonly TOOL_CALL_ARGUMENTS: "gen_ai.tool.call.arguments";
    readonly TOOL_CALL_RESULT: "gen_ai.tool.call.result";
};
/** Default span name builders for chat / execute_tool / invoke_agent. */
export declare const GenAiSpanName: {
    chat: (provider: string) => string;
    executeTool: (toolName: string) => string;
    invokeAgent: (agentName: string) => string;
};
//# sourceMappingURL=genai.d.ts.map