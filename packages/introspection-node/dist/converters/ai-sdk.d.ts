/**
 * Converter for AI SDK event data → Gen AI semantic conventions.
 *
 * Converts typed event objects (messages, tool definitions, step results)
 * from the AI SDK's TelemetryIntegration callbacks into the standardized
 * gen_ai format used by the Introspection backend.
 *
 * Used by {@link IntrospectionAISDKIntegration}.
 */
import type { InputMessage, OutputMessage, SystemInstruction, ToolDefinition } from "../types/genai.js";
/**
 * Convert AI SDK messages (ModelMessage[]) to gen_ai InputMessage[].
 * System messages are excluded — they're handled separately via
 * {@link extractSystemInstructions}.
 *
 * @param messages - Array of AI SDK ModelMessage objects.
 * @returns Array of gen_ai InputMessage objects (without system messages).
 */
export declare function convertMessagesToInputMessages(messages: readonly unknown[]): InputMessage[];
/**
 * Extract gen_ai system instructions from AI SDK's system field and messages.
 *
 * The AI SDK provides system prompts in two places:
 * - The `system` parameter (string, SystemModelMessage, or array)
 * - Messages with role "system"
 *
 * @param system - The AI SDK `system` field.
 * @param messages - The messages array (may contain system-role messages).
 * @returns System instructions in gen_ai format, or undefined if none.
 */
export declare function extractSystemInstructions(system: unknown, messages: readonly unknown[]): SystemInstruction[] | undefined;
/**
 * Build gen_ai output messages from AI SDK step result data.
 *
 * Combines text, reasoning, and tool call outputs into a single assistant
 * OutputMessage, mirroring the order used by vercel.ts (reasoning → text → tool calls).
 *
 * @param options - Step result fields.
 * @returns Array of gen_ai OutputMessage objects.
 */
export declare function buildOutputMessages(options: {
    text?: string;
    reasoningText?: string;
    reasoning?: readonly {
        text?: string;
    }[];
    toolCalls?: readonly {
        toolCallId: string;
        toolName: string;
        input: unknown;
    }[];
    finishReason?: string;
}): OutputMessage[];
/**
 * Convert AI SDK ToolSet to gen_ai ToolDefinition[].
 *
 * The AI SDK represents tools as `Record<string, Tool>` where each Tool has
 * description and parameters (usually a Zod schema). We extract what we can
 * without importing Zod.
 *
 * @param tools - AI SDK ToolSet (Record<string, Tool>).
 * @returns Array of gen_ai ToolDefinition objects, or undefined if no tools.
 */
export declare function convertToolsToToolDefinitions(tools: unknown): ToolDefinition[] | undefined;
//# sourceMappingURL=ai-sdk.d.ts.map