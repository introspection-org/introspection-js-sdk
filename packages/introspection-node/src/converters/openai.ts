/**
 * OpenAI format conversion functions for OTel Gen AI Semantic Conventions.
 *
 * These functions convert OpenAI API formats (Responses API, Agents SDK) to the
 * standardized OTel Gen AI Semantic Convention format for gen_ai.input.messages
 * and gen_ai.output.messages attributes.
 */

import type { Responses } from "openai/resources/responses/responses";
import type {
  InputMessage,
  OutputMessage,
  MessagePart,
  ReasoningPart,
  ToolDefinition,
  SystemInstruction,
} from "../types/genai.js";

/** Re-export OpenAI types used by callers (e.g. tracing-processor). */
export type ResponseInputItem = Responses.ResponseInputItem;
export type ResponseOutputItem = Responses.ResponseOutputItem;
export type ResponseTool = Responses.Tool;
export type ResponseUsage = Responses.ResponseUsage;
export type Response = Responses.Response;

/** Safely access a property from a union type by going through `unknown`. */
function asRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>;
}

/**
 * Extract text content from a message content field (string or array of content parts).
 */
function extractContentParts(content: unknown): MessagePart[] {
  const parts: MessagePart[] = [];
  if (typeof content === "string") {
    parts.push({ type: "text", content });
  } else if (Array.isArray(content)) {
    for (const item of content) {
      const rec = asRecord(item);
      if (rec.type === "output_text") {
        parts.push({
          type: "text",
          content: (rec.text as string) || "",
        });
      } else if (typeof item === "object" && item !== null) {
        parts.push(item as unknown as MessagePart);
      } else {
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
export function convertResponsesInputsToSemconv(
  inputs: ResponseInputItem[] | undefined,
  instructions: string | undefined,
): [InputMessage[], InputMessage[]] {
  const inputMessages: InputMessage[] = [];
  const systemInstructions: InputMessage[] = [];

  if (instructions) {
    systemInstructions.push({
      role: "system",
      parts: [{ type: "text", content: instructions }],
    });
  }

  if (inputs) {
    for (const inp of inputs) {
      const item = asRecord(inp);
      const role = (item.role as string) || "user";
      const typ = item.type as string | undefined;
      const content = item.content;

      if ((typ === undefined || typ === "message") && content) {
        const parts = extractContentParts(content);
        inputMessages.push({ role: role as InputMessage["role"], parts });
      } else if (typ === "function_call") {
        inputMessages.push({
          role: "assistant",
          parts: [
            {
              type: "tool_call",
              id: item.call_id as string | undefined,
              name: item.name as string,
              arguments: item.arguments,
            },
          ],
        });
      } else if (typ === "function_call_output") {
        const msg: InputMessage = {
          role: "tool",
          parts: [
            {
              type: "tool_call_response",
              id: item.call_id as string | undefined,
              response: item.output,
            },
          ],
        };
        if (item.name) {
          msg.name = item.name as string;
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
export function convertResponsesOutputsToSemconv(
  outputs: ResponseOutputItem[],
): OutputMessage[] {
  // Reasoning and web_search_call parts are collected as prefixes and merged
  // into the next message's parts array, matching the format the frontend expects
  // (thinking + text in the same message).
  const prefixParts: MessagePart[] = [];
  const outputMessages: OutputMessage[] = [];
  let pendingWebSearchId: string | undefined;

  for (const out of outputs) {
    const item = asRecord(out);
    const typ = item.type as string | undefined;
    const content = item.content;

    if (typ === "mcp_call") {
      const name = (item.name as string) || "mcp_tool";
      const server = (item.server_label as string) || "";
      const toolName = server ? `${server}/${name}` : name;
      const args = item.arguments as string | undefined;
      const output = item.output as string | undefined;
      const error = item.error as string | undefined;
      prefixParts.push({
        type: "tool_call",
        id: item.id as string | undefined,
        name: toolName,
        arguments: args,
      });
      prefixParts.push({
        type: "tool_call_response",
        id: item.id as string | undefined,
        response: error || output || "",
      });
    } else if (typ === "mcp_list_tools") {
      // Skip — tool discovery metadata, not a user-facing message
    } else if (typ === "reasoning") {
      const summary = item.summary as
        | Array<Record<string, unknown>>
        | undefined;
      const texts = (summary ?? [])
        .map((s) => (s.text as string) || "")
        .filter(Boolean);
      const content = texts.length > 0 ? texts.join("\n") : undefined;
      const signature =
        (item.encrypted_content as string | undefined) || undefined;
      const thinkingPart: ReasoningPart = {
        type: "thinking",
        content,
        signature,
        provider_name: "openai",
      };
      prefixParts.push(thinkingPart);
    } else if (typ === "web_search_call") {
      const action = item.action as Record<string, unknown> | undefined;
      const query = action?.query as string | undefined;
      prefixParts.push({
        type: "tool_call",
        id: item.id as string | undefined,
        name: "web_search",
        arguments: query ? JSON.stringify({ query }) : undefined,
      });
      pendingWebSearchId = item.id as string | undefined;
    } else if ((typ === undefined || typ === "message") && content) {
      // Extract search result citations from annotations if this follows a web search
      if (pendingWebSearchId) {
        const contentItems = Array.isArray(content) ? content : [];
        const citations: string[] = [];
        for (const ci of contentItems) {
          const rec = asRecord(ci);
          const anns = rec.annotations as
            | Array<Record<string, unknown>>
            | undefined;
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
          response:
            citations.length > 0 ? citations.join("\n") : "search completed",
        });
        pendingWebSearchId = undefined;
      }

      const parts = extractContentParts(content);
      const status = item.status as string | undefined;
      const finishReason = status === "completed" ? "stop" : undefined;
      outputMessages.push({
        role: "assistant",
        parts: [...prefixParts, ...parts],
        finish_reason: finishReason,
      });
      prefixParts.length = 0;
    } else if (typ === "function_call") {
      outputMessages.push({
        role: "assistant",
        finish_reason: "tool-calls",
        parts: [
          {
            type: "tool_call",
            id: item.call_id as string | undefined,
            name: item.name as string,
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
export function convertResponsesToolsToSemconv(
  tools: ResponseTool[],
): ToolDefinition[] {
  const toolDefs: ToolDefinition[] = [];
  for (const tool of tools) {
    if (tool.type === "function") {
      const toolDef: ToolDefinition = { name: tool.name };
      if (tool.description) toolDef.description = tool.description;
      if (tool.parameters)
        toolDef.parameters = tool.parameters as Record<string, unknown>;
      toolDefs.push(toolDef);
    } else {
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
export function convertResponsesInstructionsToSemconv(
  instructions: string | ResponseInputItem[] | null | undefined,
): SystemInstruction[] | undefined {
  if (!instructions) return undefined;
  if (typeof instructions === "string") {
    return [{ type: "text", content: instructions }];
  }
  // Array of ResponseInputItem used as instructions
  const result: SystemInstruction[] = [];
  for (const item of instructions) {
    const rec = asRecord(item);
    if (typeof rec.content === "string") {
      result.push({ type: "text", content: rec.content });
    }
  }
  return result.length > 0 ? result : undefined;
}
