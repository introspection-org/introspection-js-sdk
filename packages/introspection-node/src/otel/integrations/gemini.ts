/**
 * Gemini (`@google/genai`) integration.
 *
 * Patches `Models.prototype.generateContentInternal` / `…StreamInternal` so
 * every `GoogleGenAI` client is traced. Preserves the thought-signature
 * capture the standalone `GeminiInstrumentor` is built for.
 */

import * as genai from "@google/genai";

import { GeminiInstrumentor } from "../gemini.js";
import type { Integration } from "./base.js";

const integration: Integration = {
  identifier: "gemini",
  setupOnce({ tracerProvider }) {
    const instrumentor = new GeminiInstrumentor();
    instrumentor.instrumentClass({ genai, tracerProvider });
    // Restore the original prototype on shutdown so a later init() re-patches
    // against the rebuilt provider (the patch captures the provider's tracer).
    return () => instrumentor.uninstrument();
  },
};

export default integration;
