/**
 * Claude Agent SDK format conversion functions for OTel Gen AI Semantic Conventions.
 *
 * These functions convert Claude Agent SDK message formats to the standardized
 * OTel Gen AI Semantic Convention format for gen_ai.input.messages and gen_ai.output.messages.
 */
import { toAttributes } from "../types/genai.js";
/**
 * Convert a user prompt string to OTel Gen AI input message format.
 *
 * @param prompt - The user's text prompt.
 * @returns An array containing a single user-role {@link InputMessage}.
 *
 * @example
 * ```ts
 * const msgs = convertClaudePromptToInputMessages("Hello, Claude!");
 * // [{ role: "user", parts: [{ type: "text", content: "Hello, Claude!" }] }]
 * ```
 */
export function convertClaudePromptToInputMessages(prompt) {
    return [
        {
            role: "user",
            parts: [{ type: "text", content: prompt }],
        },
    ];
}
/**
 * Convert Claude content blocks to message parts.
 */
function convertContentBlocksToParts(content) {
    if (typeof content === "string") {
        return [{ type: "text", content }];
    }
    const parts = [];
    for (const block of content) {
        if (block.type === "text" && "text" in block) {
            parts.push({ type: "text", content: block.text });
        }
        else if (block.type === "tool_use" && "name" in block) {
            parts.push({
                type: "tool_call",
                id: block.id,
                name: block.name,
                arguments: block.input,
            });
        }
        else if (block.type === "tool_result" && "tool_use_id" in block) {
            let response = block.content;
            if (typeof response === "string") {
                // Keep as string
            }
            else if (Array.isArray(response)) {
                // Extract text from content array
                response = response
                    .filter((item) => typeof item === "object" &&
                    item !== null &&
                    item.type === "text")
                    .map((item) => item.text)
                    .join("");
            }
            parts.push({
                type: "tool_call_response",
                id: block.tool_use_id,
                response,
            });
        }
        else if (block.type === "thinking" && "thinking" in block) {
            const thinking = block.thinking;
            const signature = block.signature;
            const thinkingPart = {
                type: "thinking",
                content: thinking || undefined,
                signature: signature || undefined,
                provider_name: "anthropic",
            };
            parts.push(thinkingPart);
        }
    }
    return parts;
}
/**
 * Convert Claude assistant response content to OTel Gen AI output message format.
 *
 * @param content - A plain string or array of {@link ClaudeContentBlock} objects.
 * @param stopReason - Optional stop/finish reason (e.g. `"end_turn"`).
 * @returns An array containing a single assistant-role {@link OutputMessage}.
 *
 * @example
 * ```ts
 * const msgs = convertClaudeResponseToOutputMessages(response.content, response.stop_reason);
 * span.setAttribute("gen_ai.output.messages", JSON.stringify(msgs));
 * ```
 */
export function convertClaudeResponseToOutputMessages(content, stopReason) {
    const parts = convertContentBlocksToParts(content);
    const message = {
        role: "assistant",
        parts,
    };
    if (stopReason) {
        message.finish_reason = stopReason;
    }
    return [message];
}
/**
 * Convert a Claude multi-turn conversation to OTel Gen AI input message format.
 *
 * @param messages - Array of {@link ClaudeMessage} objects (user + assistant turns).
 * @returns An array of {@link InputMessage} objects preserving turn order.
 *
 * @example
 * ```ts
 * const msgs = convertClaudeMessagesToInputMessages(conversation);
 * span.setAttribute("gen_ai.input.messages", JSON.stringify(msgs));
 * ```
 */
export function convertClaudeMessagesToInputMessages(messages) {
    return messages.map((msg) => ({
        role: msg.role,
        parts: convertContentBlocksToParts(msg.content),
    }));
}
/**
 * Convert Claude session data to camelCase {@link GenAiAttributes}.
 *
 * @param data - Aggregated {@link ClaudeSessionData} for one session.
 * @returns A {@link GenAiAttributes} object ready for {@link toAttributes}.
 *
 * @example
 * ```ts
 * const genAi = convertClaudeSessionToGenAI({ model: "claude-sonnet-4-20250514", inputTokens: 100 });
 * const otel  = toAttributes(genAi);
 * ```
 */
export function convertClaudeSessionToGenAI(data) {
    const result = {};
    // Set system
    result.system = "anthropic";
    // Set model
    if (data.model) {
        result.requestModel = data.model;
    }
    // Convert input to gen_ai.input.messages format
    if (data.inputPrompt) {
        result.inputMessages = convertClaudePromptToInputMessages(data.inputPrompt);
    }
    // Convert output to gen_ai.output.messages format
    if (data.responseBlocks) {
        result.outputMessages = convertClaudeResponseToOutputMessages(data.responseBlocks, data.stopReason);
    }
    else if (data.responseContent) {
        result.outputMessages = convertClaudeResponseToOutputMessages(data.responseContent, data.stopReason);
    }
    // Set token counts
    if (data.inputTokens !== undefined) {
        result.inputTokens = data.inputTokens;
    }
    if (data.outputTokens !== undefined) {
        result.outputTokens = data.outputTokens;
    }
    // Set response ID
    if (data.responseId) {
        result.responseId = data.responseId;
    }
    // Set tool definitions from tool names
    if (data.toolNames && data.toolNames.length > 0) {
        result.toolDefinitions = data.toolNames.map((name) => ({ name }));
    }
    // Set system instructions
    if (data.systemInstructions) {
        result.systemInstructions = [
            { type: "text", content: data.systemInstructions },
        ];
    }
    return result;
}
/**
 * Convert Claude session data directly to OTel span attributes with `gen_ai.*`
 * dot-notation keys, plus Claude-specific keys like `claude.session_id`.
 *
 * @param data - Aggregated {@link ClaudeSessionData} for one session.
 * @returns A flat dictionary suitable for `span.setAttributes()`.
 *
 * @example
 * ```ts
 * const attrs = convertClaudeSessionToOtelAttributes(sessionData);
 * for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v);
 * ```
 */
export function convertClaudeSessionToOtelAttributes(data) {
    const genaiAttrs = convertClaudeSessionToGenAI(data);
    const result = toAttributes(genaiAttrs);
    // Add Claude-specific attributes
    if (data.sessionId) {
        result["claude.session_id"] = data.sessionId;
    }
    if (data.costUsd !== undefined) {
        result["gen_ai.cost.usd"] = data.costUsd;
    }
    return result;
}
