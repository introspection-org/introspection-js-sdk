/**
 * Converts Pi Agent SDK message types to/from OTel Gen AI semantic convention format.
 *
 * Pure functions — produce JSON strings matching the gen_ai.input.messages
 * and gen_ai.output.messages attribute schemas.
 *
 * Gen AI semconv message format:
 *   { role: "user"|"assistant"|"tool", parts: MessagePart[], finish_reason?: string }
 *
 * MessagePart types:
 *   { type: "text", content: string }
 *   { type: "thinking", content: string }
 *   { type: "tool_call", name: string, id?: string, arguments?: unknown }
 *   { type: "tool_call_response", id?: string, result?: unknown }
 */
/**
 * Convert Pi Agent Message[] to gen_ai.input.messages JSON string.
 */
export declare function piMessagesToSemconv(messages: unknown[]): string;
/**
 * Convert a single Pi AssistantMessage to gen_ai.output.messages JSON string.
 */
export declare function piAssistantToSemconv(result: unknown): string;
/**
 * Wrap a system prompt string in gen_ai.system_instructions format.
 */
export declare function piSystemPromptToSemconv(systemPrompt: string): string;
/**
 * Convert gen_ai.input.messages semconv format back to Pi Agent Message[] format.
 *
 * Used to hydrate conversation history when resuming an agent task from the
 * DP API's reconstructed `messages` payload.
 *
 * - Thinking parts are skipped (no thinkingSignature stored).
 * - tool_call_response toolName is resolved from preceding assistant tool_call parts.
 * - Returns typed-as-unknown[] to avoid importing pi-ai types.
 */
export declare function semconvToPiMessages(raw: unknown): unknown[];
//# sourceMappingURL=pi-agent.d.ts.map