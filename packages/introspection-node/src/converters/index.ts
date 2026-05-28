/**
 * Converters for transforming various API formats to OTel Gen AI Semantic Conventions.
 */

export {
  convertResponsesInputsToSemconv,
  convertResponsesOutputsToSemconv,
  convertResponsesToolsToSemconv,
  convertResponsesInstructionsToSemconv,
  type ResponseInputItem,
  type ResponseOutputItem,
  type ResponseTool,
  type ResponseUsage,
  type Response as OpenAIResponse,
} from "./openai.js";

export {
  isOpenInferenceSpan,
  convertOpenInferenceToGenAI,
  replaceOpenInferenceWithGenAI,
  addOpenInferenceAttributes,
  OpenInferenceSpanExporter,
} from "./openinference.js";

export { isVercelAISpan, convertVercelAIToGenAI } from "./vercel.js";

export {
  convertClaudePromptToInputMessages,
  convertClaudeResponseToOutputMessages,
  convertClaudeMessagesToInputMessages,
  convertClaudeSessionToGenAI,
  convertClaudeSessionToOtelAttributes,
  type ClaudeContentBlock,
  type ClaudeMessage,
  type ClaudeResponse,
  type ClaudeSessionData,
} from "./claude.js";

export {
  convertGeminiContentsToInputMessages,
  convertGeminiCandidatesToOutputMessages,
  convertGeminiSystemInstructionToSemconv,
  convertGeminiToolsToToolDefinitions,
  GEMINI_PROVIDER_NAME,
  type GeminiCandidate,
  type GeminiContent,
  type GeminiFunctionDeclaration,
  type GeminiPart,
  type GeminiTool,
} from "./gemini.js";
