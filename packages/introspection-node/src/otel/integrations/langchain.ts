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
  // Intentional, and matches the Python SDK: when @langchain/core is present,
  // auto-discovery skips the always-on raw-Anthropic prototype patch so a
  // LangChain → ChatAnthropic call isn't traced twice (once by LangChain's
  // callback handler, once by the raw `messages.create` patch).
  //
  // Trade-off (by design): if an app has BOTH @langchain/core installed AND
  // makes raw `@anthropic-ai/sdk` calls outside LangChain, those raw calls
  // won't be auto-traced. To trace them, instrument explicitly with
  // `new AnthropicInstrumentor().instrumentClass(...)`, or call
  // `init({ autoDiscover: false, integrations: [anthropicIntegration] })`.
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
