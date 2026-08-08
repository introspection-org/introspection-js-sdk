/**
 * Converters for transforming various API formats to OTel Gen AI Semantic Conventions.
 */

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
