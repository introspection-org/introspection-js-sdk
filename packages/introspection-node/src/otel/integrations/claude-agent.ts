/**
 * Claude Agent SDK integration.
 *
 * The Claude Agent SDK is instrumented by wrapping its module
 * (`withIntrospection(sdk)`), which there is no global hook for. So this
 * integration publishes a pre-bound `instrumentClaudeAgent(sdk)` handle that
 * `init()` re-exposes as `introspection.instrumentClaudeAgent(sdk)`.
 */

import { withIntrospection } from "../claude-wrapper.js";
import {
  importOptionalPeer,
  isOptionalPeerInstalled,
  OPTIONAL_PEERS,
  type Integration,
} from "./base.js";

const integration: Integration = {
  identifier: "claude_agent",
  isAvailable: () => isOptionalPeerInstalled(OPTIONAL_PEERS.claudeAgent),
  async setupOnce({ token, serviceName, baseUrl, advanced, handles }) {
    await importOptionalPeer(OPTIONAL_PEERS.claudeAgent);
    handles.instrumentClaudeAgent = (sdk) =>
      withIntrospection(sdk, {
        token,
        serviceName,
        baseUrl,
        additionalHeaders: advanced?.additionalHeaders,
        advanced: advanced?.spanExporter
          ? { spanExporter: advanced.spanExporter }
          : undefined,
      });
  },
};

export default integration;
