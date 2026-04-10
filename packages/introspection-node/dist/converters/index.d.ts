/**
 * Converters for transforming various API formats to OTel Gen AI Semantic Conventions.
 */
export { convertResponsesInputsToSemconv, convertResponsesOutputsToSemconv, convertResponsesToolsToSemconv, convertResponsesInstructionsToSemconv, type ResponseInputItem, type ResponseOutputItem, type ResponseTool, type ResponseUsage, type Response as OpenAIResponse, } from "./openai.js";
export { isOpenInferenceSpan, convertOpenInferenceToGenAI, replaceOpenInferenceWithGenAI, addOpenInferenceAttributes, OpenInferenceSpanExporter, } from "./openinference.js";
export { isVercelAISpan, convertVercelAIToGenAI } from "./vercel.js";
export { convertMessagesToInputMessages as convertAISDKMessagesToInputMessages, extractSystemInstructions as extractAISDKSystemInstructions, buildOutputMessages as buildAISDKOutputMessages, convertToolsToToolDefinitions as convertAISDKToolsToToolDefinitions, } from "./ai-sdk.js";
export { convertClaudePromptToInputMessages, convertClaudeResponseToOutputMessages, convertClaudeMessagesToInputMessages, convertClaudeSessionToGenAI, convertClaudeSessionToOtelAttributes, type ClaudeContentBlock, type ClaudeMessage, type ClaudeResponse, type ClaudeSessionData, } from "./claude.js";
//# sourceMappingURL=index.d.ts.map