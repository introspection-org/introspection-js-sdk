/**
 * @introspection-sdk/introspection-pi
 *
 * Introspection observability extension for the Pi Agent SDK
 * (`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`).
 *
 * Emits OTel GenAI semantic-convention spans for chat completions
 * (`chat ${model}`), tool execution (`execute_tool ${tool_name}`), and —
 * optionally — agent runs (`invoke_agent ${agent_name}`), plus the GenAI
 * client metrics when a meter is provided.
 *
 * @example
 * ```ts
 * import { instrumentSession } from "@introspection-sdk/introspection-pi";
 *
 * // One-call attach for a live coding-agent session:
 * const handle = instrumentSession(session, { tracer, meta });
 * // later: handle.detach();
 * ```
 *
 * @example
 * ```ts
 * import { instrumentAgent, instrumentStream } from "@introspection-sdk/introspection-pi";
 *
 * // Or compose the pieces yourself:
 * agent.streamFunction = instrumentStream(agent.streamFunction, { tracer, meta });
 * const tools = instrumentAgent(agent, { tracer, meta });
 * // later: tools.stop();
 * ```
 */

// Instrumentation
export {
  instrumentStream,
  type InstrumentStreamOptions,
} from "./instrument-stream.js";
export {
  instrumentAgent,
  type AgentInstrumentation,
  type InstrumentAgentOptions,
} from "./instrument-agent.js";
export {
  instrumentSession,
  type InstrumentableAgentSession,
  type InstrumentSessionOptions,
  type SessionInstrumentation,
} from "./instrument-session.js";

// Content scrubbing — for hosts exporting one span stream to two backends
// with different data policies (whole spans vs structure-only)
export {
  GenAiContentScrubbingExporter,
  isGenAiContentAttribute,
  scrubGenAiContent,
  type ScrubbableSpan,
  type SpanExporterLike,
} from "./scrubbing.js";

// Attribute builders — exposed for callers that want to compose their own spans
export {
  chatRequestAttributes,
  chatResponseAttributes,
  executeToolAttributes,
  executeToolResultAttribute,
  invokeAgentAttributes,
  serverAttributes,
  type AgentMeta,
} from "./attributes.js";

// Metric instruments — exposed for callers that record their own measurements
export { genAiMetrics, type GenAiMetrics } from "./metrics.js";

// Converters — exposed for telemetry replay (rebuilding pi-ai message arrays
// from stored span attributes) and downstream consumers that want the raw
// semconv shapes.
export {
  assistantToOutputMessages,
  inputMessagesToMessages,
  messagesToInputMessages,
  semconvFinishReason,
  systemPromptToInstructions,
  type ConvertOptions,
} from "./convert.js";

// Re-export the GenAI types so consumers don't need a second import.
export type {
  AbortTerminationReason,
  GenAiAttributes,
  InputMessage,
  MessagePart,
  MessageRole,
  OutputMessage,
  ReasoningPart,
  SystemInstruction,
  TextPart,
  ToolCallRequestPart,
  ToolCallResponsePart,
  ToolDefinition,
} from "@introspection-sdk/types";
export {
  GenAi,
  GenAiSpanName,
  IntrospectionAttr,
  toAttributes,
} from "@introspection-sdk/types";
