/**
 * OpenAI Agents SDK integration.
 *
 * Registers an {@link IntrospectionTracingProcessor} with the Agents SDK's
 * global trace pipeline. `addTraceProcessor` appends, preserving any processors
 * other integrations (e.g. a vendor exporter) already registered.
 */

import { IntrospectionTracingProcessor } from "../tracing-processor.js";
import {
  importOptionalPeer,
  isOptionalPeerInstalled,
  OPTIONAL_PEERS,
  type Integration,
} from "./base.js";

interface OpenAIAgentsModule {
  addTraceProcessor?: (processor: IntrospectionTracingProcessor) => void;
}

const integration: Integration = {
  identifier: "openai_agents",
  isAvailable: () => isOptionalPeerInstalled(OPTIONAL_PEERS.openaiAgents),
  async setupOnce({ token, serviceName, baseUrl, advanced }) {
    const { addTraceProcessor } = await importOptionalPeer<OpenAIAgentsModule>(
      OPTIONAL_PEERS.openaiAgents,
    );
    if (!addTraceProcessor) {
      throw new Error(
        "Invalid @openai/agents module: addTraceProcessor missing",
      );
    }
    addTraceProcessor(
      new IntrospectionTracingProcessor({
        token,
        serviceName,
        baseUrl,
        additionalHeaders: advanced?.additionalHeaders,
        advanced: advanced?.spanExporter
          ? { spanExporter: advanced.spanExporter }
          : undefined,
      }),
    );
  },
};

export default integration;
