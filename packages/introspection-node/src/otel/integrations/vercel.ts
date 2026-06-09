/**
 * Vercel AI SDK integration.
 *
 * The AI SDK emits `ai.*` / `gen_ai.*` attributes natively via OTel when
 * `experimental_telemetry` is enabled. The shared provider already carries an
 * {@link IntrospectionSpanProcessor}, which converts those `ai.*` attributes to
 * canonical `gen_ai.*` semconv at span end — so there is nothing to patch here.
 * This integration exists so auto-discovery reports the AI SDK as detected and
 * (via its top-level import) is skipped when `ai` is not installed.
 */

import {
  isOptionalPeerInstalled,
  OPTIONAL_PEERS,
  type Integration,
} from "./base.js";

const integration: Integration = {
  identifier: "vercel",
  isAvailable: () => isOptionalPeerInstalled(OPTIONAL_PEERS.vercelAi),
  setupOnce() {
    // No-op: the shared IntrospectionSpanProcessor converts AI SDK spans.
  },
};

export default integration;
