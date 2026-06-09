/**
 * Anthropic Node SDK integration.
 *
 * Patches `Anthropic.Messages.prototype.create` so every `new Anthropic()`
 * client is traced against the shared provider — no per-client wiring.
 */

import { AnthropicInstrumentor } from "../anthropic.js";
import {
  importOptionalPeer,
  isOptionalPeerInstalled,
  OPTIONAL_PEERS,
  type Integration,
} from "./base.js";

async function loadAnthropicSdk(): Promise<unknown> {
  const mod = await importOptionalPeer<{ default?: unknown }>(
    OPTIONAL_PEERS.anthropic,
  );
  return mod.default ?? mod;
}

const integration: Integration = {
  identifier: "anthropic",
  isAvailable: () => isOptionalPeerInstalled(OPTIONAL_PEERS.anthropic),
  async setupOnce({ tracerProvider }) {
    const Anthropic = await loadAnthropicSdk();
    const instrumentor = new AnthropicInstrumentor();
    instrumentor.instrumentClass({ anthropic: Anthropic, tracerProvider });
    // Restore the original prototype on shutdown so a later init() re-patches
    // against the rebuilt provider (the patch captures the provider's tracer).
    return () => instrumentor.uninstrument();
  },
};

export default integration;
