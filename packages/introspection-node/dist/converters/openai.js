/**
 * OpenAI format conversion functions for OTel Gen AI Semantic Conventions.
 *
 * These functions convert OpenAI API formats (Responses API, Agents SDK) to the
 * standardized OTel Gen AI Semantic Convention format for gen_ai.input.messages
 * and gen_ai.output.messages attributes.
 */
/** Safely access a property from a union type by going through `unknown`. */
function asRecord(value) {
    return value;
}
/**
 * Extract text content from a message content field (string or array of content parts).
 */
function extractContentParts(content) {
    const parts = [];
    if (typeof content === "string") {
        parts.push({ type: "text", content });
    }
    else if (Array.isArray(content)) {
        for (const item of content) {
            const rec = asRecord(item);
            if (rec.type === "output_text") {
                parts.push({
                    type: "text",
                    content: rec.text || "",
                });
            }
            else if (typeof item === "object" && item !== null) {
                parts.push(item);
            }
            else {
                parts.push({ type: "text", content: String(item) });
            }
        }
    }
    return parts;
}
/**
 * Convert OpenAI Responses API inputs to OTel Gen AI Semantic Convention format.
 *
 * Handles `message`, `function_call`, and `function_call_output` input types.
 * System instructions are returned separately so callers can set
 * `gen_ai.system_instructions` independently from `gen_ai.input.messages`.
 *
 * @param inputs - Input items array from the Responses API request body.
 * @param instructions - Optional system instructions / system prompt string.
 * @returns A `[inputMessages, systemInstructions]` tuple of {@link InputMessage} arrays.
 */
export function convertResponsesInputsToSemconv(inputs, instructions) {
    const inputMessages = [];
    const systemInstructions = [];
    if (instructions) {
        systemInstructions.push({
            role: "system",
            parts: [{ type: "text", content: instructions }],
        });
    }
    if (inputs) {
        for (const inp of inputs) {
            const item = asRecord(inp);
            const role = item.role || "user";
            const typ = item.type;
            const content = item.content;
            if ((typ === undefined || typ === "message") && content) {
                const parts = extractContentParts(content);
                inputMessages.push({ role: role, parts });
            }
            else if (typ === "function_call") {
                inputMessages.push({
                    role: "assistant",
                    parts: [
                        {
                            type: "tool_call",
                            id: item.call_id,
                            name: item.name,
                            arguments: item.arguments,
                        },
                    ],
                });
            }
            else if (typ === "function_call_output") {
                const msg = {
                    role: "tool",
                    parts: [
                        {
                            type: "tool_call_response",
                            id: item.call_id,
                            response: item.output,
                        },
                    ],
                };
                if (item.name) {
                    msg.name = item.name;
                }
                inputMessages.push(msg);
            }
        }
    }
    return [inputMessages, systemInstructions];
}
/**
 * Convert OpenAI Responses API outputs to OTel Gen AI Semantic Convention format.
 *
 * Maps `message` and `function_call` output types to {@link OutputMessage} objects.
 *
 * @param outputs - Output items array from the Responses API response body.
 * @returns An array of {@link OutputMessage} objects in semconv format.
 */
export function convertResponsesOutputsToSemconv(outputs) {
    // Reasoning and web_search_call parts are collected as prefixes and merged
    // into the next message's parts array, matching the format the frontend expects
    // (thinking + text in the same message).
    const prefixParts = [];
    const outputMessages = [];
    let pendingWebSearchId;
    for (const out of outputs) {
        const item = asRecord(out);
        const typ = item.type;
        const content = item.content;
        if (typ === "mcp_call") {
            const name = item.name || "mcp_tool";
            const server = item.server_label || "";
            const toolName = server ? `${server}/${name}` : name;
            const args = item.arguments;
            const output = item.output;
            const error = item.error;
            prefixParts.push({
                type: "tool_call",
                id: item.id,
                name: toolName,
                arguments: args,
            });
            prefixParts.push({
                type: "tool_call_response",
                id: item.id,
                response: error || output || "",
            });
        }
        else if (typ === "mcp_list_tools") {
            // Skip — tool discovery metadata, not a user-facing message
        }
        else if (typ === "reasoning") {
            const summary = item.summary;
            const texts = (summary ?? [])
                .map((s) => s.text || "")
                .filter(Boolean);
            const content = texts.length > 0 ? texts.join("\n") : undefined;
            const signature = item.encrypted_content || undefined;
            const thinkingPart = {
                type: "thinking",
                content,
                signature,
                provider_name: "openai",
            };
            prefixParts.push(thinkingPart);
        }
        else if (typ === "web_search_call") {
            const action = item.action;
            const query = action?.query;
            prefixParts.push({
                type: "tool_call",
                id: item.id,
                name: "web_search",
                arguments: query ? JSON.stringify({ query }) : undefined,
            });
            pendingWebSearchId = item.id;
        }
        else if ((typ === undefined || typ === "message") && content) {
            // Extract search result citations from annotations if this follows a web search
            if (pendingWebSearchId) {
                const contentItems = Array.isArray(content) ? content : [];
                const citations = [];
                for (const ci of contentItems) {
                    const rec = asRecord(ci);
                    const anns = rec.annotations;
                    if (anns) {
                        for (const ann of anns) {
                            if (ann.title && ann.url) {
                                citations.push(`${ann.title}: ${ann.url}`);
                            }
                        }
                    }
                }
                prefixParts.push({
                    type: "tool_call_response",
                    id: pendingWebSearchId,
                    response: citations.length > 0 ? citations.join("\n") : "search completed",
                });
                pendingWebSearchId = undefined;
            }
            const parts = extractContentParts(content);
            const status = item.status;
            const finishReason = status === "completed" ? "stop" : undefined;
            outputMessages.push({
                role: "assistant",
                parts: [...prefixParts, ...parts],
                finish_reason: finishReason,
            });
            prefixParts.length = 0;
        }
        else if (typ === "function_call") {
            outputMessages.push({
                role: "assistant",
                finish_reason: "tool-calls",
                parts: [
                    {
                        type: "tool_call",
                        id: item.call_id,
                        name: item.name,
                        arguments: item.arguments,
                    },
                ],
            });
        }
    }
    // Leftover prefix parts with no message to attach to
    if (prefixParts.length > 0) {
        outputMessages.push({ role: "assistant", parts: [...prefixParts] });
    }
    return outputMessages;
}
/**
 * Convert OpenAI Responses API tool definitions to GenAI ToolDefinition format.
 *
 * @param tools - The tools array from the Response object.
 * @returns An array of {@link ToolDefinition} objects.
 */
export function convertResponsesToolsToSemconv(tools) {
    const toolDefs = [];
    for (const tool of tools) {
        if (tool.type === "function") {
            const toolDef = { name: tool.name };
            if (tool.description)
                toolDef.description = tool.description;
            if (tool.parameters)
                toolDef.parameters = tool.parameters;
            toolDefs.push(toolDef);
        }
        else {
            // For non-function tools (web_search, file_search, etc.)
            toolDefs.push({ name: tool.type });
        }
    }
    return toolDefs;
}
/**
 * Convert OpenAI Response instructions to GenAI SystemInstruction format.
 *
 * @param instructions - The instructions field from the Response object.
 * @returns An array of {@link SystemInstruction} objects, or undefined if no instructions.
 */
export function convertResponsesInstructionsToSemconv(instructions) {
    if (!instructions)
        return undefined;
    if (typeof instructions === "string") {
        return [{ type: "text", content: instructions }];
    }
    // Array of ResponseInputItem used as instructions
    const result = [];
    for (const item of instructions) {
        const rec = asRecord(item);
        if (typeof rec.content === "string") {
            result.push({ type: "text", content: rec.content });
        }
    }
    return result.length > 0 ? result : undefined;
}
