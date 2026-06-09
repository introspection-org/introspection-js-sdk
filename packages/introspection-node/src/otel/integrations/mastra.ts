/**
 * Mastra integration.
 *
 * The Mastra exporter is wired into Mastra's `observability.configs` rather
 * than globally, so this integration builds the exporter — pre-bound to the
 * `init()` token — and publishes it via `introspection.getMastraExporter()`.
 *
 * Importing `../mastra-exporter.js` (which requires `@mastra/observability`)
 * is the presence gate: a missing Mastra makes discovery skip this shim.
 */

import {
  importOptionalPeer,
  isOptionalPeerInstalled,
  OPTIONAL_PEERS,
  type Integration,
} from "./base.js";

const importLocal = (specifier: string) =>
  import(specifier) as Promise<{
    IntrospectionMastraExporter: new (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options: any,
    ) => unknown;
  }>;

const integration: Integration = {
  identifier: "mastra",
  isAvailable: () =>
    isOptionalPeerInstalled(OPTIONAL_PEERS.mastraObservability),
  async setupOnce({ token, baseUrl, advanced, handles }) {
    await importOptionalPeer(OPTIONAL_PEERS.mastraObservability);
    const { IntrospectionMastraExporter } = await importLocal(
      "../mastra-exporter.js",
    );
    handles.mastraExporter = new IntrospectionMastraExporter({
      token,
      baseUrl,
      additionalHeaders: advanced?.additionalHeaders,
      debug: advanced?.debug,
      advanced: advanced?.spanExporter
        ? { spanExporter: advanced.spanExporter }
        : undefined,
    });
  },
};

export default integration;
