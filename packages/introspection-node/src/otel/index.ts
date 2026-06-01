/**
 * OpenTelemetry surface for the Introspection Node SDK.
 *
 * Subpath entry point: `@introspection-sdk/introspection-node/otel`.
 *
 * Importing from here pulls in OTel SDK packages (peer deps). The
 * REST-only `IntrospectionClient` is available from the package root
 * and does not require these to be installed.
 */

// IntrospectionLogs — OTel logs exporter with track/feedback/identify
// and baggage context helpers (extracted from the old IntrospectionClient).
export { IntrospectionLogs } from "./logs.js";
export type { IntrospectionLogsOptions } from "./logs.js";

// One-call tracing bootstrap (NodeTracerProvider + AsyncLocalStorage +
// W3C baggage propagator + IntrospectionSpanProcessor).
export { setupTracing } from "./setup.js";
export type { SetupTracingOptions, ConflictBehavior } from "./setup.js";

// Span processor — attach to your own TracerProvider.
export { IntrospectionSpanProcessor } from "./span-processor.js";
export type { IntrospectionSpanProcessorOptions } from "./span-processor.js";

// OpenAI Agents SDK tracing processor.
export { IntrospectionTracingProcessor } from "./tracing-processor.js";
export type {
  IntrospectionTracingProcessorOptions,
  TracingProcessorAdvancedOptions,
} from "./tracing-processor.js";

// Claude Agent SDK hooks.
export { IntrospectionClaudeHooks } from "./claude-hooks.js";
export type {
  IntrospectionClaudeHooksOptions,
  ClaudeHooksAdvancedOptions,
  ClaudeHooksConfig,
  ClaudeHookCallbackMatcher,
  ClaudeHookEvent,
  ClaudeHookInput,
  ClaudeHookOutput,
  ClaudeHookCallback,
  ClaudeUsage,
  ClaudeModelUsage,
  ClaudeResultMessage,
  ClaudeAssistantMessage,
  ClaudeSDKMessage,
} from "./claude-hooks.js";

// Claude Agent SDK wrapper.
export { withIntrospection } from "./claude-wrapper.js";
export type {
  WithIntrospectionOptions,
  InstrumentedClaudeAgentSDK,
  ClaudeAgentSDKModule,
} from "./claude-wrapper.js";

// Anthropic SDK instrumentor.
export {
  AnthropicInstrumentor,
  tracedMessagesCreate,
  REDACTED_THINKING_CONTENT,
} from "./anthropic.js";

// Pi Agent SDK instrumentor.
export { IntrospectionPiInstrumentor } from "./pi.js";
export type {
  IntrospectionPiInstrumentorOptions,
  AgentMeta as PiAgentMeta,
} from "./pi.js";

// Gemini SDK instrumentor.
export { GeminiInstrumentor } from "./gemini.js";

// OpenInference span exporter (drops Arize/OpenInference attrs onto a
// downstream OTel SpanExporter).
export {
  addOpenInferenceAttributes,
  OpenInferenceSpanExporter,
} from "../converters/openinference.js";

// One-liner bootstrap (`introspection.init()`) + analytics proxies and the
// per-framework handle accessors it binds. Auto-detects installed frameworks
// and wires them into one shared provider.
export {
  init,
  shutdown,
  track,
  feedback,
  identify,
  conversation,
  withAgent,
  withConversation,
  withUserId,
  withAnonymousId,
  newConversationId,
  getClient,
  getTracerProvider,
  getLangchainHandler,
  getMastraExporter,
  instrumentPi,
  instrumentClaudeAgent,
  _resetForTests,
} from "./init.js";
export type { InitOptions } from "./init.js";

// Low-level OTel registration helper (also used by `init`).
export { registerOTelGlobals } from "./setup.js";

// Integration registry — for custom integrations passed to `init`.
export {
  DidNotEnable,
  discoverIntegrations,
  setupIntegrations,
  resetInstalledForTests,
} from "./integrations/index.js";
export type {
  Integration,
  IntegrationSetupContext,
  IntegrationHandles,
} from "./integrations/index.js";
