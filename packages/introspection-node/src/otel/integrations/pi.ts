/**
 * Pi Agent SDK integration.
 *
 * The Pi instrumentor wraps a specific `Agent` instance, so this integration
 * builds the instrumentor — bound to the shared provider's global tracer — and
 * publishes it via `introspection.instrumentPi(agent, meta)`.
 */

import { IntrospectionPiInstrumentor } from "../pi.js";
import {
  importOptionalPeer,
  isOptionalPeerInstalled,
  OPTIONAL_PEERS,
  type Integration,
} from "./base.js";

const integration: Integration = {
  identifier: "pi",
  isAvailable: () => isOptionalPeerInstalled(OPTIONAL_PEERS.piAgentCore),
  async setupOnce({ handles }) {
    await importOptionalPeer(OPTIONAL_PEERS.piAgentCore);
    // The instrumentor emits onto the global tracer, which `init()` has just
    // registered with the shared IntrospectionSpanProcessor.
    const instrumentor = new IntrospectionPiInstrumentor();
    handles.piInstrumentor = instrumentor;
    // Returning the teardown is what makes `introspection.shutdown()` reach
    // the instrumentor. Without it, open `execute_tool` spans stayed open and
    // instrumented agents kept emitting onto a shut-down provider.
    return () => {
      instrumentor.stop();
      handles.piInstrumentor = undefined;
    };
  },
};

export default integration;
