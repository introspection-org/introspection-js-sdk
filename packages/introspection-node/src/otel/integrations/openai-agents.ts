/**
 * OpenAI Agents SDK integration.
 *
 * Registers an {@link IntrospectionTracingProcessor} with the Agents SDK's
 * global trace pipeline. `addTraceProcessor` appends, preserving any processors
 * other integrations (e.g. a vendor exporter) already registered.
 */

import { addTraceProcessor } from "@openai/agents";

import { IntrospectionTracingProcessor } from "../tracing-processor.js";
import type { Integration } from "./base.js";

const integration: Integration = {
  identifier: "openai_agents",
  setupOnce({ token, serviceName, baseUrl, advanced }) {
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
