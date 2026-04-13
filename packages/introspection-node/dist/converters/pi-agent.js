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
export function piMessagesToSemconv(messages) {
    const result = [];
    for (const msg of messages) {
        const m = msg;
        if (m.role === "user") {
            const userMsg = m;
            const text = typeof userMsg.content === "string"
                ? userMsg.content
                : extractTextFromBlocks(userMsg.content);
            result.push({
                role: "user",
                parts: [{ type: "text", content: text }],
            });
        }
        else if (m.role === "assistant") {
            result.push(convertAssistantMessage(m));
        }
        else if (m.role === "toolResult") {
            const tr = m;
            result.push({
                role: "tool",
                parts: [
                    {
                        type: "tool_call_response",
                        id: tr.toolCallId,
                        result: extractToolResultContent(tr.content),
                    },
                ],
            });
        }
    }
    return JSON.stringify(result);
}
/**
 * Convert a single Pi AssistantMessage to gen_ai.output.messages JSON string.
 */
export function piAssistantToSemconv(result) {
    const msg = result;
    const converted = convertAssistantMessage(msg);
    return JSON.stringify([converted]);
}
/**
 * Wrap a system prompt string in gen_ai.system_instructions format.
 */
export function piSystemPromptToSemconv(systemPrompt) {
    return JSON.stringify([{ type: "text", content: systemPrompt }]);
}
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
export function semconvToPiMessages(raw) {
    if (!Array.isArray(raw) || raw.length === 0)
        return [];
    const messages = [];
    // Build toolCallId -> toolName map from assistant tool_call parts
    const toolNameById = new Map();
    for (const msg of raw) {
        const parts = msg.parts ?? [];
        if (msg.role === "user") {
            const text = parts
                .filter((p) => p.type === "text")
                .map((p) => p.content ?? "")
                .join("");
            if (!text)
                continue;
            messages.push({ role: "user", content: text, timestamp: 0 });
        }
        else if (msg.role === "assistant") {
            const content = [];
            for (const part of parts) {
                if (part.type === "text" && part.content) {
                    content.push({ type: "text", text: part.content });
                }
                else if (part.type === "tool_call") {
                    if (part.id && part.name) {
                        toolNameById.set(part.id, part.name);
                    }
                    let args = part.arguments ?? {};
                    if (typeof args === "string") {
                        try {
                            args = JSON.parse(args);
                        }
                        catch {
                            args = {};
                        }
                    }
                    content.push({
                        type: "toolCall",
                        id: part.id ?? "",
                        name: part.name ?? "",
                        arguments: args,
                    });
                }
                // Skip thinking parts: thinkingSignature not stored in semconv
            }
            if (content.length === 0)
                continue;
            messages.push({
                role: "assistant",
                content,
                api: "anthropic-messages",
                provider: "anthropic",
                model: "",
                usage: { input: 0, output: 0, totalTokens: 0 },
                stopReason: msg.finish_reason ?? "end_turn",
                timestamp: 0,
            });
        }
        else if (msg.role === "tool") {
            for (const part of parts) {
                if (part.type !== "tool_call_response")
                    continue;
                const id = part.id ?? "";
                // name is not stored in semconv tool_call_response; resolve from map
                const name = part.name ??
                    toolNameById.get(id) ??
                    "";
                if (!id || !name) {
                    continue;
                }
                const resultRaw = part.result;
                const result = typeof resultRaw === "string"
                    ? resultRaw
                    : resultRaw != null
                        ? JSON.stringify(resultRaw)
                        : "";
                messages.push({
                    role: "toolResult",
                    toolCallId: id,
                    toolName: name,
                    content: [{ type: "text", text: result }],
                    isError: false,
                    timestamp: 0,
                });
            }
        }
    }
    return sanitizeToolPairing(messages);
}
/**
 * Remove toolResult messages whose toolCallId doesn't have a matching
 * toolCall in the preceding assistant message. Also strips unmatched
 * tool_use blocks from the final assistant message.
 */
function sanitizeToolPairing(messages) {
    const result = [];
    let activeToolCallIds = new Set();
    for (const msg of messages) {
        const m = msg;
        if (m.role === "assistant") {
            activeToolCallIds = new Set();
            if (Array.isArray(m.content)) {
                for (const block of m.content) {
                    const b = block;
                    if (b.type === "toolCall" && b.id) {
                        activeToolCallIds.add(b.id);
                    }
                }
            }
            result.push(msg);
        }
        else if (m.role === "toolResult") {
            if (m.toolCallId && activeToolCallIds.has(m.toolCallId)) {
                activeToolCallIds.delete(m.toolCallId);
                result.push(msg);
            }
        }
        else {
            activeToolCallIds = new Set();
            result.push(msg);
        }
    }
    // Strip unmatched tool_use blocks from the last assistant message
    if (activeToolCallIds.size > 0 && result.length > 0) {
        for (let i = result.length - 1; i >= 0; i--) {
            const m = result[i];
            if (m.role !== "assistant")
                continue;
            if (Array.isArray(m.content)) {
                const cleaned = m.content.filter((block) => {
                    const b = block;
                    return !(b.type === "toolCall" &&
                        b.id &&
                        activeToolCallIds.has(b.id));
                });
                if (cleaned.length === 0) {
                    result.splice(i, 1);
                }
                else {
                    m.content = cleaned;
                }
            }
            break;
        }
    }
    return result;
}
// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────
function convertAssistantMessage(msg) {
    const parts = [];
    for (const block of msg.content ?? []) {
        switch (block.type) {
            case "text":
                if (block.text) {
                    parts.push({ type: "text", content: block.text });
                }
                break;
            case "thinking":
                if (block.thinking || block.text) {
                    parts.push({
                        type: "thinking",
                        content: block.thinking || block.text,
                    });
                }
                break;
            case "toolCall":
                parts.push({
                    type: "tool_call",
                    name: block.name,
                    id: block.id,
                    arguments: block.arguments,
                });
                break;
            case "tool_result":
                parts.push({
                    type: "tool_call_response",
                    id: block.toolCallId,
                    result: extractToolResultContent(block.content),
                });
                break;
            default:
                if (block.text) {
                    parts.push({ type: "text", content: block.text });
                }
                break;
        }
    }
    const result = {
        role: "assistant",
        parts,
    };
    if (msg.stopReason) {
        result.finish_reason = msg.stopReason;
    }
    return result;
}
function extractTextFromBlocks(blocks) {
    return blocks
        .map((b) => {
        if (b.type === "text")
            return b.text ?? "";
        return "";
    })
        .filter(Boolean)
        .join("");
}
function extractToolResultContent(content) {
    if (typeof content === "string")
        return content;
    if (!content)
        return "";
    if (Array.isArray(content)) {
        return content
            .map((block) => {
            if (typeof block === "string")
                return block;
            const b = block;
            if (b?.type === "text" && b.text)
                return b.text;
            return "";
        })
            .filter(Boolean)
            .join("\n");
    }
    if (typeof content === "object") {
        const c = content;
        return c.text ?? c.content ?? JSON.stringify(content);
    }
    return String(content);
}
