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

import {
  importOptionalPeer,
  isOptionalPeerInstalled,
  OPTIONAL_PEERS,
  type Integration,
} from "./base.js";
import type { IntrospectionCallbackHandler } from "../langchain-handler.js";

const importLocal = (specifier: string) =>
  import(specifier) as Promise<{
    IntrospectionCallbackHandler: new (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options: any,
    ) => IntrospectionCallbackHandler;
  }>;

const integration: Integration = {
  identifier: "langchain",
  isAvailable: () => isOptionalPeerInstalled(OPTIONAL_PEERS.langchainCallbacks),
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
  async setupOnce({ token, serviceName, baseUrl, advanced, handles }) {
    await importOptionalPeer(OPTIONAL_PEERS.langchainCallbacks);
    const { IntrospectionCallbackHandler } = await importLocal(
      "../langchain-handler.js",
    );
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
