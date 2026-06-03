/**
 * Pi Agent SDK integration.
 *
 * The Pi instrumentor wraps a specific `Agent` instance, so this integration
 * builds the instrumentor — bound to the shared provider's global tracer — and
 * publishes it via `introspection.instrumentPi(agent, meta)`.
 */

// Presence gate.
import "@earendil-works/pi-agent-core";

import { IntrospectionPiInstrumentor } from "../pi.js";
import type { Integration } from "./base.js";

const integration: Integration = {
  identifier: "pi",
  setupOnce({ handles }) {
    // The instrumentor emits onto the global tracer, which `init()` has just
    // registered with the shared IntrospectionSpanProcessor.
    handles.piInstrumentor = new IntrospectionPiInstrumentor();
  },
};

export default integration;
