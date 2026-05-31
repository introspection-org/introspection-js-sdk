/**
 * LangChain / LangGraph integration.
 *
 * The callback handler is attached per-invoke (`chain.invoke(input, { callbacks
 * })`), so this integration builds the handler — pre-bound to the `init()`
 * token — and publishes it via `introspection.getLangchainHandler()`.
 *
 * Deactivates the Anthropic integration: when LangChain drives the Anthropic
 * model, the handler already traces the call, so the prototype-level Anthropic
 * patch would double-trace it.
 */

// Presence gate.
import "@langchain/core/callbacks/base";

import { IntrospectionCallbackHandler } from "../langchain-handler.js";
import type { Integration } from "./base.js";

const integration: Integration = {
  identifier: "langchain",
  deactivates: ["anthropic"],
  setupOnce({ token, serviceName, baseUrl, advanced, handles }) {
    handles.langchainHandler = new IntrospectionCallbackHandler({
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
