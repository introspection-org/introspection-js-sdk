/**
 * Anthropic Node SDK integration.
 *
 * Patches `Anthropic.Messages.prototype.create` so every `new Anthropic()`
 * client is traced against the shared provider — no per-client wiring.
 */

// Top-level import gates availability: if `@anthropic-ai/sdk` is not installed
// the dynamic import of this module rejects and discovery skips the shim.
import Anthropic from "@anthropic-ai/sdk";

import { AnthropicInstrumentor } from "../anthropic.js";
import type { Integration } from "./base.js";

const integration: Integration = {
  identifier: "anthropic",
  setupOnce({ tracerProvider }) {
    new AnthropicInstrumentor().instrumentClass({
      anthropic: Anthropic,
      tracerProvider,
    });
  },
};

export default integration;
