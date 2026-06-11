/**
 * @introspection-sdk/introspection-pi
 *
 * Introspection observability extension for the Pi Agent SDK
 * (`@earendil-works/pi-ai`, `@earendil-works/pi-agent-core`).
 *
 * Emits OTel GenAI semantic-convention spans for chat completions
 * (`chat ${provider}`) and tool execution (`execute_tool ${tool_name}`).
 *
 * @example
 * ```ts
 * import { instrumentAgent, instrumentStream } from "@introspection-sdk/introspection-pi";
 *
 * agent.streamFn = instrumentStream(agent.streamFn, { tracer, meta });
 * const tools = instrumentAgent(agent, { tracer, meta });
 *
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

// Attribute builders — exposed for callers that want to compose their own spans
export {
  chatRequestAttributes,
  chatResponseAttributes,
  executeToolAttributes,
  executeToolResultAttribute,
  type AgentMeta,
} from "./attributes.js";

// Converters — exposed for telemetry replay (rebuilding pi-ai message arrays
// from stored span attributes) and downstream consumers that want the raw
// semconv shapes.
export {
  assistantToOutputMessages,
  inputMessagesToMessages,
  messagesToInputMessages,
  systemPromptToInstructions,
  type ConvertOptions,
} from "./convert.js";

// Re-export the GenAI types so consumers don't need a second import.
export type {
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
export { GenAi, GenAiSpanName, toAttributes } from "@introspection-sdk/types";
