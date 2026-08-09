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

// Pi Agent SDK instrumentor: `@introspection-sdk/introspection-node/otel/pi`.
//
// Deliberately not re-exported here. `./pi.js` reaches
// `@earendil-works/pi-ai` for a value (`createAssistantMessageEventStream`),
// so a static export would make importing this barrel throw
// ERR_MODULE_NOT_FOUND for every user who does not have Pi installed --
// exactly the invariant `integrations/base.ts` states. `init()` still wires
// Pi automatically when it is present, via the lazy integration loader, and
// exposes the bound handle as `introspection.instrumentPi()`.

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
  instrumentPi,
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
