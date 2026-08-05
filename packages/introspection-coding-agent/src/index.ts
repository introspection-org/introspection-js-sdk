/**
 * Opt-in OTEL capture of Claude Code and Codex sessions.
 *
 * Turns a host's own session transcript into GenAI spans under
 * `service.name = "introspection-plugin"`, authenticated with the Introspection
 * CLI's existing login so plugin activity correlates with the org, project, and
 * member captured during onboarding.
 *
 * Host transcripts are parsed by `@letta-ai/trajectory`, the same normalization
 * the eval harness reaches through Harbor — so a production session and an eval
 * trajectory describe the same run the same way, and the two are comparable
 * without a second parser to keep in sync.
 *
 * Capture is off until a recorded opt-in enables it; see {@link resolveTelemetryConfig}.
 */
export { capture } from "./capture.js";
export type {
  CaptureOutcome,
  CaptureRequest,
  CaptureResult,
} from "./capture.js";

export {
  activationRequestPath,
  captureActivationPath,
  clearCaptureActivationRequest,
  materializeCaptureActivation,
  readCaptureActivation,
  requestCaptureActivation,
  requestCaptureActivationFromEnvironment,
  transcriptIdentity,
  CAPTURE_ACTIVATION_VERSION,
} from "./activation.js";
export type {
  CaptureActivationMarker,
  CaptureActivationOutcome,
  CaptureActivationRequest,
  CaptureActivationResult,
} from "./activation.js";

export {
  coversHost,
  readTelemetryOverride,
  resolveTelemetryConfig,
  telemetryConfigPath,
  TELEMETRY_CONFIG_VERSION,
} from "./config.js";
export type { CaptureHost, ContentCapture, TelemetryConfig } from "./config.js";

export {
  credentialsPath,
  loadLoginProfile,
  resolveTracesEndpoint,
  CREDENTIALS_VERSION,
  EXPIRY_SKEW_SECONDS,
} from "./credentials.js";
export type { LoginProfile } from "./credentials.js";

export { createTracing } from "./exporter.js";
export type { CaptureTracing } from "./exporter.js";

export { providerForHost, readHostInfo } from "./host.js";
export type { HostInfo } from "./host.js";

export {
  parseHookEvent,
  readStdin,
  runHook,
  HOOK_DEADLINE_MS,
} from "./hook.js";
export type { HookEvent } from "./hook.js";

export { emitTurnSpans, resourceAttributes } from "./spans.js";
export type { TurnContext, TurnSpans } from "./spans.js";

export {
  captureStatePath,
  readCaptureState,
  writeCaptureState,
  CAPTURE_STATE_VERSION,
} from "./state.js";
export type { CaptureState } from "./state.js";

export { responseIdForTurn, segmentTranscript } from "./turns.js";
export type {
  SegmentedTranscript,
  SourceMetadata,
  TranscriptTurn,
} from "./turns.js";

export { SERVICE_NAME, VERSION } from "./version.js";
