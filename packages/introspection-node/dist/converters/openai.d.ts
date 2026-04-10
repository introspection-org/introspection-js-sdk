/**
 * OpenAI format conversion functions for OTel Gen AI Semantic Conventions.
 *
 * These functions convert OpenAI API formats (Responses API, Agents SDK) to the
 * standardized OTel Gen AI Semantic Convention format for gen_ai.input.messages
 * and gen_ai.output.messages attributes.
 */
import type { Responses } from "openai/resources/responses/responses";
import type { InputMessage, OutputMessage, ToolDefinition, SystemInstruction } from "../types/genai.js";
/** Re-export OpenAI types used by callers (e.g. tracing-processor). */
export type ResponseInputItem = Responses.ResponseInputItem;
export type ResponseOutputItem = Responses.ResponseOutputItem;
export type ResponseTool = Responses.Tool;
export type ResponseUsage = Responses.ResponseUsage;
export type Response = Responses.Response;
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
export declare function convertResponsesInputsToSemconv(inputs: ResponseInputItem[] | undefined, instructions: string | undefined): [InputMessage[], InputMessage[]];
/**
 * Convert OpenAI Responses API outputs to OTel Gen AI Semantic Convention format.
 *
 * Maps `message` and `function_call` output types to {@link OutputMessage} objects.
 *
 * @param outputs - Output items array from the Responses API response body.
 * @returns An array of {@link OutputMessage} objects in semconv format.
 */
export declare function convertResponsesOutputsToSemconv(outputs: ResponseOutputItem[]): OutputMessage[];
/**
 * Convert OpenAI Responses API tool definitions to GenAI ToolDefinition format.
 *
 * @param tools - The tools array from the Response object.
 * @returns An array of {@link ToolDefinition} objects.
 */
export declare function convertResponsesToolsToSemconv(tools: ResponseTool[]): ToolDefinition[];
/**
 * Convert OpenAI Response instructions to GenAI SystemInstruction format.
 *
 * @param instructions - The instructions field from the Response object.
 * @returns An array of {@link SystemInstruction} objects, or undefined if no instructions.
 */
export declare function convertResponsesInstructionsToSemconv(instructions: string | ResponseInputItem[] | null | undefined): SystemInstruction[] | undefined;
//# sourceMappingURL=openai.d.ts.map