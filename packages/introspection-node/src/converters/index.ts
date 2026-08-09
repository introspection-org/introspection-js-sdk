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
