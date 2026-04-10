import { IntrospectionSpanProcessor } from "./span-processor.js";
import type { IntrospectionSpanProcessorOptions } from "./span-processor.js";
/**
 * Factory that creates an {@link IntrospectionSpanProcessor}.
 *
 * Provided as the default export for convenient use with logfire's
 * `additionalSpanProcessors` option.
 *
 * @param options - Optional processor configuration (token, serviceName, etc.).
 * @returns A ready-to-use {@link IntrospectionSpanProcessor}.
 *
 * @example
 * ```ts
 * import introspectionSpanProcessor from "@introspection-sdk/introspection-node";
 *
 * logfire.configure({ additionalSpanProcessors: [introspectionSpanProcessor()] });
 * ```
 */
export default function introspectionSpanProcessor(options?: IntrospectionSpanProcessorOptions): IntrospectionSpanProcessor;
export { IntrospectionSpanProcessor } from "./span-processor.js";
export type { IntrospectionSpanProcessorOptions } from "./span-processor.js";
export { IntrospectionClient } from "./client.js";
export type { AdvancedOptions, IntrospectionClientOptions, FeedbackOptions, UserTraits, } from "./types.js";
export { IntrospectionTracingProcessor } from "./tracing-processor.js";
export type { IntrospectionTracingProcessorOptions, TracingProcessorAdvancedOptions, } from "./tracing-processor.js";
export { IntrospectionClaudeHooks } from "./claude-hooks.js";
export type { IntrospectionClaudeHooksOptions, ClaudeHooksAdvancedOptions, ClaudeHooksConfig, ClaudeHookCallbackMatcher, ClaudeHookEvent, ClaudeHookInput, ClaudeHookOutput, ClaudeHookCallback, ClaudeUsage, ClaudeModelUsage, ClaudeResultMessage, ClaudeAssistantMessage, ClaudeSDKMessage, } from "./claude-hooks.js";
export { withIntrospection } from "./claude-wrapper.js";
export type { WithIntrospectionOptions, InstrumentedClaudeAgentSDK, ClaudeAgentSDKModule, } from "./claude-wrapper.js";
export type { GenAiAttributes, InputMessage, OutputMessage, SystemInstruction, ToolDefinition, TextPart, ToolCallRequestPart, ToolCallResponsePart, MessagePart, } from "./types/genai.js";
export { toAttributes } from "./types/genai.js";
export { convertResponsesInputsToSemconv, convertResponsesOutputsToSemconv, convertResponsesToolsToSemconv, convertResponsesInstructionsToSemconv, } from "./converters/openai.js";
export type { ResponseInputItem, ResponseOutputItem, ResponseTool, ResponseUsage, Response as OpenAIResponse, } from "./converters/openai.js";
export { IntrospectionAISDKIntegration } from "./ai-sdk-integration.js";
export type { IntrospectionAISDKIntegrationOptions, AISDKIntegrationAdvancedOptions, } from "./ai-sdk-integration.js";
export { addOpenInferenceAttributes, OpenInferenceSpanExporter, } from "./converters/openinference.js";
export { AnthropicInstrumentor, tracedMessagesCreate, REDACTED_THINKING_CONTENT, } from "./anthropic.js";
//# sourceMappingURL=index.d.ts.map